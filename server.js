#!/usr/bin/env node

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const natural = require('natural');
const ffmpeg = require('fluent-ffmpeg');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');

// Sharp for image metadata extraction (optional)
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.log('Sharp not available for EXIF extraction');
}

// Face recognition service (optional - only loaded if dependencies are available)
let FaceRecognitionService = null;
let faceService = null;
try {
  FaceRecognitionService = require('./face-recognition-service');
  const FACES_DIR = path.join(__dirname, 'faces');
  // Will be initialized after BASE_PATH is loaded
} catch (error) {
  console.log('Face recognition not available (dependencies not installed)');
}

const app = express();
const PORT = 3000;

// Base path for video files - will be loaded from config
let BASE_PATH = '/srv/nas/research/p/';
const FILELIST_PATH = path.join(__dirname, 'filelist.txt');
const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.txt');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATE_CACHE_FILE = path.join(__dirname, 'date-cache.json');
const HASH_CACHE_FILE = path.join(__dirname, 'hash-cache.json');
const DB_FILE = path.join(__dirname, 'media.db');

// Create thumbnails directory if it doesn't exist
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

// Initialize SQLite database
let db = null;

function initializeDatabase() {
  console.log('Initializing database...');
  db = new Database(DB_FILE);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -16000'); // 16MB page cache
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      file_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      file_size INTEGER,
      mtime INTEGER,
      date TEXT,
      date_source TEXT,
      file_hash TEXT,
      resolution TEXT,
      has_thumbnail INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type);
    CREATE INDEX IF NOT EXISTS idx_files_date ON files(date);
    CREATE INDEX IF NOT EXISTS idx_files_resolution ON files(resolution);
    CREATE INDEX IF NOT EXISTS idx_files_file_hash ON files(file_hash);

    CREATE TABLE IF NOT EXISTS stems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      stem TEXT NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_stems_file_id ON stems(file_id);
    CREATE INDEX IF NOT EXISTS idx_stems_stem ON stems(stem);
    CREATE INDEX IF NOT EXISTS idx_stems_stem_file ON stems(stem, file_id);
    CREATE INDEX IF NOT EXISTS idx_files_type_date ON files(file_type, date);
    CREATE INDEX IF NOT EXISTS idx_files_type_resolution ON files(file_type, resolution);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_login INTEGER
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (user_id, file_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_favorites_file ON favorites(file_id);

    CREATE TABLE IF NOT EXISTS actors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);

  console.log('Database initialized successfully');
  return db;
}

// Middleware setup
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Read credentials from file
function readCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      console.warn(`Credentials file not found: ${CREDENTIALS_FILE}`);
      return [];
    }
    
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    const credentials = [];
    
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split(':');
        if (parts.length >= 2) {
          const username = parts[0].trim();
          const password = parts.slice(1).join(':').trim(); // Support passwords with colons
          if (username && password) {
            credentials.push({ username, password });
          }
        }
      }
    });
    
    return credentials;
  } catch (error) {
    console.error('Error reading credentials file:', error);
    return [];
  }
}

// Verify credentials
function verifyCredentials(username, password) {
  const credentials = readCredentials();
  return credentials.some(cred => 
    cred.username === username && cred.password === password
  );
}

function getOrCreateUser(username) {
  if (!db || !username) return null;
  db.prepare(`
    INSERT INTO users (username, last_login)
    VALUES (?, strftime('%s', 'now'))
    ON CONFLICT(username) DO UPDATE SET last_login = strftime('%s', 'now')
  `).run(username);
  return db.prepare('SELECT id, username, created_at, last_login FROM users WHERE username = ?').get(username);
}

function getSessionUser(req) {
  if (!req.session || !req.session.authenticated || !req.session.username) {
    return null;
  }
  if (req.session.userId) {
    return { id: req.session.userId, username: req.session.username };
  }
  const user = getOrCreateUser(req.session.username);
  if (user) {
    req.session.userId = user.id;
    return { id: user.id, username: user.username };
  }
  return null;
}

function getFavoriteCount(userId) {
  if (!db || !userId) return 0;
  const row = db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?').get(userId);
  return row ? row.count : 0;
}

function attachFavoriteFlags(items, userId) {
  if (!items.length) return items;
  if (!userId) {
    return items.map(item => ({ ...item, favorited: false }));
  }
  const names = items.map(item => item.filename);
  const placeholders = names.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT f.filename
    FROM favorites fav
    JOIN files f ON f.id = fav.file_id
    WHERE fav.user_id = ? AND f.filename IN (${placeholders})
  `).all(userId, ...names);
  const favorited = new Set(rows.map(row => row.filename));
  return items.map(item => ({ ...item, favorited: favorited.has(item.filename) }));
}

// Authentication middleware
function requireAuth(req, res, next) {
  // Allow access to login page, login API, and config API without authentication
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/auth/status' || req.path === '/api/config' || req.path === '/images/logo.png') {
    return next();
  }
  
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  // Redirect to login for HTML requests, return 401 for API requests
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  res.redirect('/login');
}

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);
      
      // Update BASE_PATH if specified in config (support both old and new name for backward compatibility)
      if (config.mediaConfigPath) {
        BASE_PATH = config.mediaConfigPath;
      } else if (config.videoBasePath) {
        // Backward compatibility
        BASE_PATH = config.videoBasePath;
      }
      
      // Ensure it ends with a slash
      if (BASE_PATH && !BASE_PATH.endsWith('/')) {
        BASE_PATH += '/';
      }
      
      return {
        systemName: config.systemName || 'Movie Tube',
        mediaConfigPath: BASE_PATH
      };
    }
  } catch (error) {
    console.error('Error loading config file:', error);
  }
  
  // Default values
  return {
    systemName: 'Movie Tube',
    mediaConfigPath: BASE_PATH
  };
}

let appConfig = loadConfig();

// Also allow environment variable to override (for backward compatibility)
if (process.env.BASE_PATH) {
  BASE_PATH = process.env.BASE_PATH;
  if (!BASE_PATH.endsWith('/')) {
    BASE_PATH += '/';
  }
  appConfig.mediaConfigPath = BASE_PATH;
}

// Initialize face recognition service if available
if (FaceRecognitionService) {
  try {
    const FACES_DIR = path.join(__dirname, 'faces');
    faceService = new FaceRecognitionService(BASE_PATH, FACES_DIR);
    console.log('Face recognition service initialized');
  } catch (error) {
    console.error('Error initializing face recognition service:', error);
    faceService = null;
  }
}

// API endpoint to get configuration (accessible without auth for login page)
app.get('/api/config', (req, res) => {
  res.json(appConfig);
});

// Apply authentication middleware to all routes
app.use(requireAuth);

// Serve static files from public directory (after auth check)
app.use(express.static('public', {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));

// Stemmer instance
const stemmer = natural.PorterStemmer;

// Helper function to generate thumbnail filename
function getThumbnailPath(filename) {
  // Create a safe filename for the thumbnail
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(THUMBNAILS_DIR, `${safeName}.jpg`);
}

function decodeFilenameParam(value) {
  if (value == null) return '';
  const raw = String(value);
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    return raw;
  }
}

function resolveLibraryPath(filename) {
  if (!filename || typeof filename !== 'string' || filename.includes('\0')) {
    return null;
  }
  const resolvedBase = path.resolve(BASE_PATH);
  const resolvedPath = path.resolve(path.join(BASE_PATH, filename));
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(prefix)) {
    return null;
  }
  return resolvedPath;
}

function removeFilenameFromFilelist(filename) {
  if (!fs.existsSync(FILELIST_PATH)) return;
  const content = fs.readFileSync(FILELIST_PATH, 'utf-8');
  const next = content
    .split('\n')
    .filter(line => line.trim() !== filename)
    .join('\n');
  if (next !== content) {
    fs.writeFileSync(FILELIST_PATH, next);
  }
}

// PDF thumbnail generation is disabled to avoid crashes
// PDFs will use a placeholder SVG icon instead
// If you want to enable PDF thumbnails, you can:
// 1. Install poppler-utils: sudo apt-get install poppler-utils (Linux) or brew install poppler (macOS)
// 2. Use pdf-poppler or similar library
// 3. Or use a headless browser solution (but Puppeteer was causing crashes)

// Generate thumbnail from video
function generateThumbnail(videoPath, thumbnailPath, callback) {
  // Ensure we have absolute paths
  const absoluteVideoPath = path.resolve(videoPath);
  const absoluteThumbnailPath = path.resolve(thumbnailPath);

  // Verify it's a file, not a directory
  try {
    const stats = fs.statSync(absoluteVideoPath);
    if (!stats.isFile()) {
      return callback(new Error('Path is not a file'), null);
    }
  } catch (err) {
    return callback(new Error(`File not found: ${absoluteVideoPath}`), null);
  }

  // First, get video duration to calculate a random seek position
  ffmpeg.ffprobe(absoluteVideoPath, (err, metadata) => {
    if (err) {
      console.error(`Error probing video ${absoluteVideoPath}:`, err.message);
      return callback(err, null);
    }

    // Get duration in seconds
    const duration = metadata.format.duration || 0;

    if (duration === 0) {
      return callback(new Error('Could not determine video duration'), null);
    }

    // Pick a random position between 20-80% of video duration
    const minSeek = duration * 0.20;
    const maxSeek = duration * 0.80;
    const seekTime = minSeek + Math.random() * (maxSeek - minSeek);

    // OPTIMIZATION FOR RASPBERRY PI:
    // Use input seeking (-ss before input) which is MUCH faster and uses less memory
    // Only decode 1 second of video after the seek point
    ffmpeg()
      .input(absoluteVideoPath)
      .inputOptions([
        '-ss', seekTime.toString(),  // Seek BEFORE reading (input seeking - fast, low memory)
        '-t', '1'                     // Only read 1 second after seek point
      ])
      .outputOptions([
        '-vframes', '1',              // Extract only 1 frame
        '-vf', 'scale=320:180',       // Scale to thumbnail size
        '-q:v', '2'                   // High quality (1-31, lower is better)
      ])
      .output(absoluteThumbnailPath)
      .on('end', () => {
        callback(null, absoluteThumbnailPath);
      })
      .on('error', (err) => {
        console.error(`Error generating thumbnail for ${absoluteVideoPath}:`, err.message);
        callback(err, null);
      })
      .run();
  });
}

// Generate a small JPEG thumbnail for an image (cached on disk)
async function generateImageThumbnail(imagePath, thumbnailPath) {
  if (!sharp) {
    throw new Error('Sharp is not available');
  }
  await sharp(imagePath)
    .rotate()
    .resize(480, 270, { fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toFile(thumbnailPath);
}

const inFlightThumbnails = new Map();

function ensureImageThumbnail(filename, imagePath, thumbnailPath) {
  if (fs.existsSync(thumbnailPath)) {
    return Promise.resolve(thumbnailPath);
  }
  if (inFlightThumbnails.has(filename)) {
    return inFlightThumbnails.get(filename);
  }
  const job = generateImageThumbnail(imagePath, thumbnailPath)
    .then(() => thumbnailPath)
    .finally(() => inFlightThumbnails.delete(filename));
  inFlightThumbnails.set(filename, job);
  return job;
}

// Background job to generate all missing thumbnails (runs on startup)
async function generateMissingThumbnails() {
  console.log('\n=== Starting thumbnail generation ===');

  try {
    if (!db) {
      console.log('Database not initialized, skipping thumbnail generation');
      return;
    }

    // Get all video files from database
    const videoFiles = db.prepare("SELECT id, filename FROM files WHERE file_type = 'video'").all();

    console.log(`Found ${videoFiles.length} video files to check for thumbnails`);

    let generated = 0;
    let skipped = 0;
    let errors = 0;

    const updateThumbnail = db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?');

    // Process files sequentially (single-threaded)
    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const filePath = path.join(BASE_PATH, file.filename);
      const thumbnailPath = getThumbnailPath(file.filename);

      try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
          errors++;
          continue;
        }

        // Check if thumbnail already exists
        if (fs.existsSync(thumbnailPath)) {
          updateThumbnail.run(file.id);
          skipped++;
          continue;
        }

        // Generate thumbnail
        await new Promise((resolve) => {
          generateThumbnail(filePath, thumbnailPath, (err) => {
            if (err) {
              errors++;
              // Ignore error and continue
            } else {
              updateThumbnail.run(file.id);
              generated++;
            }
            resolve();
          });
        });

        // Small delay to let Raspberry Pi free up memory between files
        await new Promise(resolve => setTimeout(resolve, 100));

        // Show progress every 50 files
        const processed = generated + skipped + errors;
        if (processed % 50 === 0) {
          console.log(`  Progress: ${processed}/${videoFiles.length} (${generated} generated, ${skipped} skipped, ${errors} errors)`);
        }
      } catch (error) {
        errors++;
        // Ignore error and continue
      }
    }

    console.log(`=== Thumbnail generation complete ===`);
    console.log(`  Total video files: ${videoFiles.length}`);
    console.log(`  Thumbnails generated: ${generated}`);
    console.log(`  Already existed (skipped): ${skipped}`);
    console.log(`  Errors (ignored): ${errors}\n`);

    if (sharp) {
      await generateMissingImageThumbnails();
    }
  } catch (error) {
    console.error('Error during thumbnail generation:', error);
  }
}

async function generateMissingImageThumbnails() {
  console.log('\n=== Starting image thumbnail generation ===');

  const imageFiles = db.prepare("SELECT id, filename FROM files WHERE file_type = 'image'").all();
  console.log(`Found ${imageFiles.length} image files to check for thumbnails`);

  let generated = 0;
  let skipped = 0;
  let errors = 0;
  const updateThumbnail = db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?');

  for (const file of imageFiles) {
    const filePath = path.join(BASE_PATH, file.filename);
    const thumbnailPath = getThumbnailPath(file.filename);

    try {
      if (!fs.existsSync(filePath)) {
        errors++;
        continue;
      }
      if (fs.existsSync(thumbnailPath)) {
        updateThumbnail.run(file.id);
        skipped++;
        continue;
      }
      await generateImageThumbnail(filePath, thumbnailPath);
      updateThumbnail.run(file.id);
      generated++;
      if ((generated + skipped + errors) % 50 === 0) {
        console.log(`  Progress: ${generated + skipped + errors}/${imageFiles.length} (${generated} generated)`);
      }
    } catch (error) {
      errors++;
    }
  }

  console.log(`=== Image thumbnail generation complete ===`);
  console.log(`  Generated: ${generated}, skipped: ${skipped}, errors: ${errors}\n`);
}

// Background job to detect all video resolutions (runs on startup)
async function detectAllVideoResolutions() {
  console.log('\n=== Starting video resolution detection ===');

  try {
    if (!db) {
      console.log('Database not initialized, skipping resolution detection');
      return;
    }

    // Get all video files without resolution or with Unknown resolution
    const videoFiles = db.prepare("SELECT id, filename FROM files WHERE file_type = 'video' AND (resolution IS NULL OR resolution = 'Unknown')").all();

    console.log(`Found ${videoFiles.length} video files to detect resolution`);

    if (videoFiles.length === 0) {
      console.log('=== Resolution detection complete ===');
      console.log('  All videos already have resolution detected\n');
      return;
    }

    let detected = 0;
    let errors = 0;

    const updateResolution = db.prepare('UPDATE files SET resolution = ? WHERE id = ?');

    // Process files sequentially (single-threaded)
    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const filePath = path.join(BASE_PATH, file.filename);

      try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
          errors++;
          continue;
        }

        // Detect resolution using ffprobe
        await new Promise((resolve) => {
          getVideoResolution(filePath, (err, result) => {
            if (err) {
              errors++;
              // Set as Unknown on error
              updateResolution.run('Unknown', file.id);
            } else {
              updateResolution.run(result.resolution, file.id);
              detected++;
            }
            resolve();
          });
        });

        // Show progress every 50 files
        const processed = detected + errors;
        if (processed % 50 === 0) {
          console.log(`  Progress: ${processed}/${videoFiles.length} (${detected} detected, ${errors} errors)`);
        }
      } catch (error) {
        errors++;
        // Ignore error and continue
      }
    }

    console.log(`=== Resolution detection complete ===`);
    console.log(`  Total video files: ${videoFiles.length}`);
    console.log(`  Resolutions detected: ${detected}`);
    console.log(`  Errors (marked as Unknown): ${errors}\n`);
  } catch (error) {
    console.error('Error during resolution detection:', error);
  }
}

// Predefined resolutions
const RESOLUTIONS = ['240p', '480p', '720p', '1080p', '2k', '4k'];
const RESOLUTIONS_DIR = path.join(__dirname, 'resolutions');

// Create resolutions directory if it doesn't exist
if (!fs.existsSync(RESOLUTIONS_DIR)) {
  fs.mkdirSync(RESOLUTIONS_DIR, { recursive: true });
}

// Map video height to standard resolution
function mapHeightToResolution(height) {
  if (height <= 240) {
    return '240p';
  } else if (height <= 480) {
    return '480p';
  } else if (height <= 720) {
    return '720p';
  } else if (height <= 1080) {
    return '1080p';
  } else if (height <= 1440) {
    return '2k'; // 1440p is considered 2K
  } else if (height <= 2160) {
    return '4k'; // 2160p is 4K
  } else {
    return '4k'; // Anything higher is considered 4K
  }
}

// Helper function to get video resolution
function getVideoResolution(videoPath, callback) {
  const absoluteVideoPath = path.resolve(videoPath);
  
  // Check if file exists
  try {
    const stats = fs.statSync(absoluteVideoPath);
    if (!stats.isFile()) {
      return callback(new Error('Path is not a file'), null);
    }
  } catch (err) {
    return callback(new Error(`File not found: ${absoluteVideoPath}`), null);
  }
  
  // Use ffprobe to get video resolution
  ffmpeg.ffprobe(absoluteVideoPath, (err, metadata) => {
    if (err) {
      console.error(`Error getting video resolution for ${absoluteVideoPath}:`, err.message);
      return callback(err, null);
    }
    
    // Find video stream
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (!videoStream || !videoStream.height) {
      return callback(new Error('No video stream found'), null);
    }
    
    const height = videoStream.height;
    const resolution = mapHeightToResolution(height);
    
    callback(null, { resolution, height, width: videoStream.width || 0 });
  });
}

// Load videos for a specific resolution
function loadVideosForResolution(resolution) {
  const resolutionFile = path.join(RESOLUTIONS_DIR, `${resolution}.txt`);
  try {
    if (fs.existsSync(resolutionFile)) {
      const content = fs.readFileSync(resolutionFile, 'utf-8');
      return content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    }
  } catch (error) {
    console.error(`Error loading videos for ${resolution}:`, error);
  }
  return [];
}

// Save video to resolution file
function saveVideoToResolution(filename, resolution) {
  const resolutionFile = path.join(RESOLUTIONS_DIR, `${resolution}.txt`);
  try {
    let videos = [];
    if (fs.existsSync(resolutionFile)) {
      const content = fs.readFileSync(resolutionFile, 'utf-8');
      videos = content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    }
    
    // Add video if not already present
    if (!videos.includes(filename)) {
      videos.push(filename);
      fs.writeFileSync(resolutionFile, videos.join('\n') + '\n');
    }
  } catch (error) {
    console.error(`Error saving video to ${resolution} file:`, error);
  }
}

// Get resolution for a video (from resolution files)
function getVideoResolutionFromFiles(filename) {
  for (const res of RESOLUTIONS) {
    const videos = loadVideosForResolution(res);
    if (videos.includes(filename)) {
      return res;
    }
  }
  return 'Unknown';
}

// Helper function to detect file type
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    return 'pdf';
  }
  // Common image extensions
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif', '.ico'];
  if (imageExtensions.includes(ext)) {
    return 'image';
  }
  // Common video extensions
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv'];
  if (videoExtensions.includes(ext)) {
    return 'video';
  }
  return 'unknown';
}

// Helper function to extract words from filename and stem them
function extractStems(filename) {
  // Remove file extension
  const nameWithoutExt = path.basename(filename, path.extname(filename));
  // Split by common delimiters and filter out empty strings
  const words = nameWithoutExt
    .split(/[\s\-_\.]+/)
    .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(word => word.length > 2); // Filter out very short words
  
  // Stem each word
  const stems = words.map(word => stemmer.stem(word));
  return [...new Set(stems)]; // Remove duplicates
}

// Date cache (in-memory and file-based) - declared early so it can be used
const dateCache = new Map();

// Hash cache (in-memory and file-based) for deduplication
const hashCache = new Map();

// Load hash cache from file
function loadHashCache() {
  try {
    if (fs.existsSync(HASH_CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(HASH_CACHE_FILE, 'utf8'));
      for (const [filename, hash] of Object.entries(cacheData)) {
        hashCache.set(filename, hash);
      }
      console.log(`Loaded ${hashCache.size} file hashes from cache`);
    }
  } catch (error) {
    console.error('Error loading hash cache:', error);
  }
}

// Save hash cache to file
function saveHashCache() {
  try {
    const cacheData = {};
    for (const [filename, hash] of hashCache.entries()) {
      cacheData[filename] = hash;
    }
    fs.writeFileSync(HASH_CACHE_FILE, JSON.stringify(cacheData, null, 2));
  } catch (error) {
    console.error('Error saving hash cache:', error);
  }
}

// Calculate SHA256 hash for a file
function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (error) => reject(error));
  });
}

// Get file hash (from cache or calculate)
async function getFileHash(filename) {
  // Check cache first
  if (hashCache.has(filename)) {
    return hashCache.get(filename);
  }
  
  const fullPath = path.join(BASE_PATH, filename);
  
  try {
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    
    const hash = await calculateFileHash(fullPath);
    hashCache.set(filename, hash);
    return hash;
  } catch (error) {
    console.error(`Error calculating hash for ${filename}:`, error.message);
    return null;
  }
}

// Deduplicate files based on SHA256 hash (runs in background)
async function deduplicateFiles() {
  console.log('\n=== Starting file deduplication ===');

  try {
    if (!db) {
      console.log('Database not initialized, skipping deduplication');
      return;
    }

    const filesNeedingHash = db.prepare('SELECT id, filename, mtime, file_hash FROM files').all();

    console.log(`Processing ${filesNeedingHash.length} files for duplicate detection...`);

    if (filesNeedingHash.length === 0) {
      console.log('No files to process');
      return;
    }

    // Group files by hash
    const hashGroups = new Map(); // hash -> array of {id, filename, mtime}
    let processed = 0;
    let errors = 0;

    const updateHash = db.prepare('UPDATE files SET file_hash = ? WHERE id = ?');

    const alreadyHashed = filesNeedingHash.filter(f => f.file_hash);
    const toHash = filesNeedingHash.filter(f => !f.file_hash);

    // Seed groups with existing hashes so duplicates can still be reported
    for (const file of alreadyHashed) {
      if (!hashGroups.has(file.file_hash)) {
        hashGroups.set(file.file_hash, []);
      }
      hashGroups.get(file.file_hash).push({
        id: file.id,
        filename: file.filename,
        mtime: file.mtime
      });
    }

    console.log(`  ${alreadyHashed.length} files already hashed, ${toHash.length} remaining`);

    for (const file of toHash) {
      try {
        const fullPath = path.join(BASE_PATH, file.filename);

        if (!fs.existsSync(fullPath)) {
          errors++;
          continue;
        }

        // Get or calculate hash
        const hash = await calculateFileHash(fullPath);

        if (!hash) {
          errors++;
          continue;
        }

        // Update hash in database
        updateHash.run(hash, file.id);

        // Group by hash
        if (!hashGroups.has(hash)) {
          hashGroups.set(hash, []);
        }
        hashGroups.get(hash).push({
          id: file.id,
          filename: file.filename,
          mtime: file.mtime
        });

        processed++;

        // Show progress every 100 files
        if (processed % 100 === 0) {
          console.log(`  Processed ${processed}/${toHash.length} files (${errors} errors)`);
        }
      } catch (error) {
        errors++;
        if (errors % 100 === 0) {
          console.log(`  Warning: ${errors} files had errors during hash calculation`);
        }
      }
    }

    // Find duplicates (hashes with more than one file)
    const duplicates = [];
    for (const [hash, fileList] of hashGroups.entries()) {
      if (fileList.length > 1) {
        // Sort by modification time (oldest first)
        fileList.sort((a, b) => a.mtime - b.mtime);
        duplicates.push({ hash, files: fileList });
      }
    }

    if (duplicates.length === 0) {
      console.log('=== Deduplication complete ===');
      console.log(`  Total files processed: ${processed}`);
      console.log(`  No duplicates found\n`);
      return;
    }

    let extraCopies = 0;
    for (const { hash, files } of duplicates) {
      extraCopies += files.length - 1;
      console.log(`  Hash ${hash.substring(0, 8)}...: ${files.length} copies, keeping "${files[0].filename}"`);
    }

    console.log(`=== Deduplication complete ===`);
    console.log(`  Newly hashed: ${processed}`);
    console.log(`  Duplicate groups: ${duplicates.length}`);
    console.log(`  Extra copies (not deleted): ${extraCopies}\n`);
  } catch (error) {
    console.error('Error during deduplication:', error);
  }
}

// Load date cache from file
function loadDateCache() {
  try {
    if (fs.existsSync(DATE_CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(DATE_CACHE_FILE, 'utf8'));
      for (const [filename, dateInfo] of Object.entries(cacheData)) {
        dateCache.set(filename, dateInfo);
      }
      console.log(`Loaded ${dateCache.size} dates from cache file: ${DATE_CACHE_FILE}`);
    } else {
      console.log(`No existing date cache found at: ${DATE_CACHE_FILE}`);
    }
  } catch (error) {
    console.error('Error loading date cache:', error);
    console.error('  Cache file path:', DATE_CACHE_FILE);
  }
}

// Save date cache to file
function saveDateCache() {
  try {
    const cacheData = {};
    for (const [filename, dateInfo] of dateCache.entries()) {
      cacheData[filename] = dateInfo;
    }
    fs.writeFileSync(DATE_CACHE_FILE, JSON.stringify(cacheData, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving date cache:', error);
    console.error('  Cache file path:', DATE_CACHE_FILE);
    console.error('  Cache size:', dateCache.size);
    return false;
  }
}

// Get file date (synchronous, uses cache)
function getFileDateSync(filename) {
  if (dateCache.has(filename)) {
    return dateCache.get(filename);
  }
  
  const fullPath = path.join(BASE_PATH, filename);
  const fileType = getFileType(filename);
  
  try {
    // Get file modification time as default
    const stats = fs.statSync(fullPath);
    let date = stats.mtime;
    let dateSource = 'file'; // 'metadata' or 'file'
    
    // Try to get EXIF date for images (if exif-reader is available)
    if (fileType === 'image') {
      try {
        const exifReader = require('exif-reader');
        if (sharp) {
          // Read image buffer
          const imageBuffer = fs.readFileSync(fullPath);
          const image = sharp(imageBuffer);
          
          // Get metadata (this is async, but we'll handle it)
          // For now, we'll use a sync workaround by checking if we can read EXIF
          // Note: This is a simplified approach - full EXIF extraction would be async
          // We'll mark it as 'file' for now, but the structure supports 'metadata' when async EXIF is implemented
        }
      } catch (exifError) {
        // exif-reader not available or error, use file date
        dateSource = 'file';
      }
    }
    
    const result = {
      date: date.toISOString(),
      source: dateSource
    };
    
    dateCache.set(filename, result);
    return result;
  } catch (error) {
    const date = new Date().toISOString();
    const result = {
      date: date,
      source: 'file'
    };
    dateCache.set(filename, result);
    return result;
  }
}

// Scan media path and populate database
function scanAndPopulateDatabase() {
  console.log('\n=== Scanning media path and populating database ===');

  try {
    if (!BASE_PATH || !fs.existsSync(BASE_PATH)) {
      console.log(`Media path does not exist: ${BASE_PATH}`);
      console.log('Skipping file scanning');
      return;
    }

    console.log(`Scanning media path: ${BASE_PATH}`);

    // Supported file extensions
    const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv'];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif', '.ico'];
    const pdfExtensions = ['.pdf'];
    const allExtensions = [...videoExtensions, ...imageExtensions, ...pdfExtensions];

    const filesFound = [];

    // Recursively find all supported files
    function scanDirectory(dir, baseDir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip macOS system files
          if (entry.name.startsWith('._') || entry.name === '.DS_Store') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Recursively scan subdirectories
            scanDirectory(fullPath, baseDir);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (allExtensions.includes(ext)) {
              // Get relative path from BASE_PATH
              const relativePath = path.relative(baseDir, fullPath);
              filesFound.push(relativePath);
            }
          }
        }
      } catch (error) {
        console.error(`Error scanning directory ${dir}:`, error.message);
      }
    }

    scanDirectory(BASE_PATH, BASE_PATH);

    console.log(`Found ${filesFound.length} files, updating database...`);

    // Get existing files from database
    const existingFiles = new Set();
    const rows = db.prepare('SELECT filename FROM files').all();
    rows.forEach(row => existingFiles.add(row.filename));

    // Prepare statements for batch insert
    const insertFile = db.prepare(`
      INSERT OR IGNORE INTO files (filename, file_type, display_name, file_size, mtime, date, date_source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStem = db.prepare(`
      INSERT INTO stems (file_id, stem)
      VALUES (?, ?)
    `);

    const getFileId = db.prepare('SELECT id FROM files WHERE filename = ?');

    let added = 0;
    let skipped = 0;

    // Use transaction for better performance
    const insertMany = db.transaction((files) => {
      for (const filename of files) {
        if (existingFiles.has(filename)) {
          skipped++;
          continue;
        }

        const fullPath = path.join(BASE_PATH, filename);
        const fileType = getFileType(filename);
        const displayName = path.basename(filename);

        try {
          const stats = fs.statSync(fullPath);
          const fileSize = stats.size;
          const mtime = stats.mtimeMs;
          const date = stats.mtime.toISOString();
          const dateSource = 'file';

          // Insert file record
          insertFile.run(filename, fileType, displayName, fileSize, mtime, date, dateSource);

          // Get the file ID
          const fileRecord = getFileId.get(filename);
          if (fileRecord) {
            // Insert stems
            const stems = extractStems(filename);
            for (const stem of stems) {
              insertStem.run(fileRecord.id, stem);
            }
          }

          added++;

          if (added % 100 === 0) {
            console.log(`  Processed ${added} files...`);
          }
        } catch (error) {
          console.error(`Error processing ${filename}:`, error.message);
        }
      }
    });

    insertMany(filesFound);

    // Clean up files that no longer exist
    const filesInDb = db.prepare('SELECT id, filename FROM files').all();
    const filesOnDisk = new Set(filesFound);
    let removed = 0;

    const deleteFile = db.prepare('DELETE FROM files WHERE id = ?');
    const deleteMany = db.transaction((filesToDelete) => {
      for (const file of filesToDelete) {
        if (!filesOnDisk.has(file.filename)) {
          deleteFile.run(file.id);
          removed++;
        }
      }
    });

    deleteMany(filesInDb);

    console.log(`=== Database population complete ===`);
    console.log(`  Files found: ${filesFound.length}`);
    console.log(`  Files added: ${added}`);
    console.log(`  Files skipped (already in DB): ${skipped}`);
    console.log(`  Files removed (no longer exist): ${removed}\n`);
  } catch (error) {
    console.error('Error scanning and populating database:', error);
  }
}

// Index all files for dates (runs on startup)
async function indexAllFileDates() {
  console.log('\n=== Starting date indexing ===');
  
  try {
    if (!fs.existsSync(FILELIST_PATH)) {
      console.log('Filelist not found, skipping date indexing');
      return;
    }
    
    const content = fs.readFileSync(FILELIST_PATH, 'utf-8');
    const files = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    const totalFiles = files.length;
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    let cacheUpdated = false;
    
    console.log(`Found ${totalFiles} files to process`);
    
    for (const file of files) {
      // Skip if already in cache
      if (dateCache.has(file)) {
        skipped++;
        continue;
      }
      
      try {
        const fullPath = path.join(BASE_PATH, file);
        
        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          errors++;
          // Log first few missing files as examples
          if (errors <= 5) {
            console.log(`  File not found: ${file} (full path: ${fullPath})`);
          }
          continue;
        }
        
        // Get file date
        const stats = fs.statSync(fullPath);
        const date = stats.mtime;
        const dateSource = 'file';
        
        const result = {
          date: date.toISOString(),
          source: dateSource
        };
        
        dateCache.set(file, result);
        processed++;
        cacheUpdated = true;
        
        // Show progress every 100 files
        if (processed % 100 === 0) {
          console.log(`  Processed ${processed}/${totalFiles} files (${skipped} cached, ${errors} errors)`);
        }
        
        // Save cache periodically (every 500 files)
        if (cacheUpdated && processed % 500 === 0) {
          saveDateCache();
          console.log(`  Saved cache (${dateCache.size} entries so far)`);
          cacheUpdated = false;
        }
      } catch (error) {
        errors++;
        // Log first few errors with details
        if (errors <= 5) {
          console.error(`  Error processing ${file}:`, error.message);
        }
        // Log summary every 100 errors
        if (errors % 100 === 0) {
          console.log(`  Warning: ${errors} files had errors processing dates`);
        }
      }
    }
    
    // Final save
    if (cacheUpdated || processed > 0) {
      saveDateCache();
      console.log(`  Final cache save completed (${dateCache.size} total entries)`);
    }
    
    console.log(`=== Date indexing complete ===`);
    console.log(`  Total files: ${totalFiles}`);
    console.log(`  Processed: ${processed}`);
    console.log(`  Cached (skipped): ${skipped}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Cache size: ${dateCache.size} entries\n`);
  } catch (error) {
    console.error('Error during date indexing:', error);
  }
}

// Helper function to extract date from file
// For images: tries EXIF metadata first, falls back to file modification time
// For other files: uses file modification time
async function getFileDate(filename) {
  const fullPath = path.join(BASE_PATH, filename);
  
  try {
    // Get file stats (modification time as fallback)
    const stats = fs.statSync(fullPath);
    const fileModTime = stats.mtime;
    
    // For images, try to get EXIF date
    const fileType = getFileType(filename);
    if (fileType === 'image' && sharp) {
      try {
        const metadata = await sharp(fullPath).metadata();
        // EXIF date fields: exif.DateTimeOriginal, exif.DateTime, exif.DateTimeDigitized
        if (metadata.exif) {
          // Parse EXIF buffer if available
          // Note: sharp doesn't parse EXIF by default, we'd need exif-reader
          // For now, we'll use file modification time
        }
        // Try to parse date from metadata if available
        if (metadata.exif && typeof metadata.exif === 'object') {
          // EXIF data might be in buffer format
          // We'll use a simpler approach: check if date is in filename
        }
      } catch (exifError) {
        // If EXIF extraction fails, use file modification time
        console.log(`EXIF extraction failed for ${filename}, using file mtime`);
      }
    }
    
    // Return file modification time as ISO string
    return fileModTime.toISOString();
  } catch (error) {
    console.error(`Error getting date for ${filename}:`, error);
    // Return current date as fallback
    return new Date().toISOString();
  }
}


function mapFileRow(row, stems = []) {
  return {
    filename: row.filename,
    fullPath: `/api/video/${encodeURIComponent(row.filename)}`,
    thumbnailPath: `/api/thumbnail/${encodeURIComponent(row.filename)}`,
    displayName: row.display_name,
    stems,
    resolution: row.resolution || (row.file_type === 'video' ? 'Unknown' : null),
    fileType: row.file_type,
    date: row.date,
    dateSource: row.date_source || 'file'
  };
}

function nameAppearsIn(text, name) {
  if (!text || !name) return false;
  const trimmed = String(name).trim();
  if (trimmed.length < 2) return false;
  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s._\\-]+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(String(text));
}

function normalizeActorName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function listActorRows() {
  if (!db) return [];
  return db.prepare('SELECT id, name FROM actors ORDER BY name COLLATE NOCASE').all();
}

function actorsForFile(filename, displayName, actorRows) {
  return actorRows
    .filter(actor => nameAppearsIn(filename, actor.name) || nameAppearsIn(displayName, actor.name))
    .map(actor => actor.name);
}

function attachActors(items) {
  const actorRows = listActorRows();
  if (!actorRows.length) {
    return items.map(item => ({ ...item, actors: [] }));
  }
  return items.map(item => ({
    ...item,
    actors: actorsForFile(item.filename, item.displayName, actorRows)
  }));
}

function getActorsWithCounts() {
  const actors = listActorRows();
  if (!actors.length) return [];
  const files = db.prepare('SELECT filename, display_name FROM files').all();
  return actors.map(actor => ({
    id: actor.id,
    name: actor.name,
    count: files.reduce((total, file) => (
      total + ((nameAppearsIn(file.filename, actor.name) || nameAppearsIn(file.display_name, actor.name)) ? 1 : 0)
    ), 0)
  }));
}

function attachStems(rows) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const stemRows = db.prepare(
    `SELECT file_id, stem FROM stems WHERE file_id IN (${placeholders})`
  ).all(...ids);
  const byFile = new Map();
  for (const row of stemRows) {
    if (!byFile.has(row.file_id)) byFile.set(row.file_id, []);
    byFile.get(row.file_id).push(row.stem);
  }
  return rows.map(row => mapFileRow(row, byFile.get(row.id) || []));
}

function parseStemList(stemFilter) {
  if (!stemFilter) return [];
  return String(stemFilter).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}

function searchTermClause(term) {
  const normalized = String(term).toLowerCase().trim();
  if (!normalized) return null;
  const cleaned = normalized.replace(/[^a-z0-9]+/g, '');
  const stemmed = cleaned ? stemmer.stem(cleaned) : '';
  const stemValues = [...new Set([normalized, stemmed].filter(Boolean))];
  const stemPlaceholders = stemValues.map(() => '?').join(',');
  const like = `%${normalized
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\s+/g, '%')}%`;
  return {
    sql: `(LOWER(f.filename) LIKE ? ESCAPE '\\' OR LOWER(f.display_name) LIKE ? ESCAPE '\\' OR f.id IN (SELECT file_id FROM stems WHERE stem IN (${stemPlaceholders})))`,
    params: [like, like, ...stemValues]
  };
}

function buildFileFilters({ fileType, resolution, dateFrom, dateTo, stems, mode, favoritesOnly, userId }) {
  const where = [];
  const params = [];

  if (fileType && fileType !== 'all') {
    where.push('f.file_type = ?');
    params.push(fileType);
  }
  if (resolution) {
    where.push("f.file_type = 'video' AND f.resolution = ?");
    params.push(resolution);
  }
  if (dateFrom) {
    where.push('f.date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('f.date <= ?');
    params.push(dateTo);
  }
  if (stems && stems.length) {
    const clauses = stems.map(searchTermClause).filter(Boolean);
    if (clauses.length) {
      const joiner = String(mode).toUpperCase() === 'AND' ? ' AND ' : ' OR ';
      where.push(`(${clauses.map(clause => clause.sql).join(joiner)})`);
      for (const clause of clauses) {
        params.push(...clause.params);
      }
    }
  }
  if (favoritesOnly && userId) {
    where.push('f.id IN (SELECT file_id FROM favorites WHERE user_id = ?)');
    params.push(userId);
  }

  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

// API endpoint to get videos with pagination and filtering
app.get('/api/videos', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const stems = parseStemList(req.query.stem);
    const user = getSessionUser(req);
    const favoritesOnly = req.query.favorites === '1' || req.query.favorites === 'true';
    const filters = buildFileFilters({
      fileType: req.query.fileType,
      resolution: req.query.resolution,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      stems,
      mode: req.query.mode,
      favoritesOnly,
      userId: user && user.id
    });

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM files f ${filters.clause}`).get(...filters.params);
    const totalVideos = countRow.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalVideos / limit) || 1);
    const offset = (page - 1) * limit;

    const unfiltered = !req.query.stem && !req.query.resolution && !req.query.fileType && !req.query.dateFrom && !req.query.dateTo && !favoritesOnly;
    const orderBy = (unfiltered && page === 1) ? 'ORDER BY RANDOM()' : 'ORDER BY f.date DESC';

    const rows = db.prepare(`
      SELECT f.id, f.filename, f.file_type, f.display_name, f.date, f.date_source, f.resolution
      FROM files f
      ${filters.clause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...filters.params, limit, offset);

    res.json({
      videos: attachActors(attachFavoriteFlags(attachStems(rows), user && user.id)),
      pagination: {
        currentPage: page,
        totalPages,
        totalVideos,
        limit
      }
    });
  } catch (error) {
    console.error('Error listing videos:', error);
    res.status(500).json({ error: 'Error listing videos' });
  }
});

// API endpoint to get date range (min and max dates)
app.get('/api/date-range', (req, res) => {
  try {
    if (!db) {
      return res.json({ minDate: null, maxDate: null });
    }
    const row = db.prepare('SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM files').get();
    res.json({
      minDate: row && row.minDate ? row.minDate : null,
      maxDate: row && row.maxDate ? row.maxDate : null
    });
  } catch (error) {
    console.error('Error getting date range:', error);
    res.json({ minDate: null, maxDate: null });
  }
});

// API endpoint to get file counts per date
app.get('/api/date-counts', (req, res) => {
  try {
    if (!db) {
      return res.json({ dateCounts: {} });
    }
    const rows = db.prepare(`
      SELECT substr(date, 1, 10) AS day, COUNT(*) AS count
      FROM files
      WHERE date IS NOT NULL AND date != ''
      GROUP BY day
    `).all();
    const dateCounts = {};
    for (const row of rows) {
      if (row.day) {
        dateCounts[row.day] = row.count;
      }
    }
    res.json({ dateCounts });
  } catch (error) {
    console.error('Error getting date counts:', error);
    res.json({ dateCounts: {} });
  }
});

// API endpoint to get all unique stems
app.get('/api/stems', (req, res) => {
  try {
    if (!db) {
      return res.json({ stems: [] });
    }
    const filters = buildFileFilters({
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null
    });
    const stems = db.prepare(`
      SELECT s.stem AS stem, COUNT(*) AS count
      FROM stems s
      JOIN files f ON f.id = s.file_id
      ${filters.clause}
      GROUP BY s.stem
      ORDER BY count DESC
      LIMIT 200
    `).all(...filters.params);
    res.json({ stems });
  } catch (error) {
    console.error('Error getting stems:', error);
    res.json({ stems: [] });
  }
});

// API endpoint to get all unique resolutions
app.get('/api/resolutions', (req, res) => {
  try {
    if (!db) {
      return res.json({ resolutions: [] });
    }
    const filters = buildFileFilters({
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null
    });
    const extra = filters.clause
      ? `${filters.clause} AND f.file_type = 'video'`
      : `WHERE f.file_type = 'video'`;
    const rows = db.prepare(`
      SELECT f.resolution AS resolution, COUNT(*) AS count
      FROM files f
      ${extra}
      GROUP BY f.resolution
    `).all(...filters.params);
    const counts = {};
    for (const row of rows) {
      if (row.resolution) {
        counts[row.resolution] = row.count;
      }
    }
    const resolutions = RESOLUTIONS.map(resolution => ({
      resolution,
      count: counts[resolution] || 0
    }));
    res.json({ resolutions });
  } catch (error) {
    console.error('Error getting resolutions:', error);
    res.json({ resolutions: [] });
  }
});

// API endpoint to detect and save video resolution
app.get('/api/detect-resolution/:filename(*)', (req, res) => {
  const filename = decodeFilenameParam(req.params.filename);
  const filePath = path.join(BASE_PATH, filename);
  const fileType = getFileType(filename);

  // Only process video files
  if (fileType !== 'video') {
    return res.json({ resolution: null, error: 'Not a video file' });
  }

  // Security check
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(BASE_PATH);

  if (!resolvedPath.startsWith(resolvedBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!db) {
    return res.status(500).json({ error: 'Database not initialized' });
  }

  // Check if already processed in database
  const fileRecord = db.prepare('SELECT id, resolution FROM files WHERE filename = ?').get(filename);
  if (!fileRecord) {
    return res.status(404).json({ error: 'File not found in database' });
  }

  if (fileRecord.resolution && fileRecord.resolution !== 'Unknown') {
    return res.json({ resolution: fileRecord.resolution, cached: true });
  }

  // Detect resolution
  getVideoResolution(filePath, (err, result) => {
    if (err) {
      console.error('Error detecting resolution:', err);
      return res.json({ resolution: 'Unknown', error: err.message });
    }

    // Update resolution in database
    const updateStmt = db.prepare('UPDATE files SET resolution = ? WHERE id = ?');
    updateStmt.run(result.resolution, fileRecord.id);

    res.json({ resolution: result.resolution, cached: false });
  });
});

// Serve video and PDF files with streaming support
app.get('/api/video/:filename(*)', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(BASE_PATH, filename);

  // Security check: ensure the path is within BASE_PATH
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(BASE_PATH);

  if (!resolvedPath.startsWith(resolvedBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileType = getFileType(filename);
  const stat = fs.statSync(resolvedPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Set appropriate content type based on file extension
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.m4v': 'video/mp4',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // Handle range requests for video streaming
  if (range && fileType === 'video') {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;

    const file = fs.createReadStream(resolvedPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600'
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    // For non-video files or requests without range header
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };

    // Add Accept-Ranges for all files to indicate streaming support
    if (fileType === 'video') {
      head['Accept-Ranges'] = 'bytes';
    }

    res.writeHead(200, head);
    fs.createReadStream(resolvedPath).pipe(res);
  }
});

function sendCachedFile(res, filePath, cacheControl) {
  res.setHeader('Cache-Control', cacheControl);
  res.sendFile(filePath, (err) => {
    if (!err) return;
    if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
      return;
    }
    console.error(`Error sending file ${filePath}:`, err);
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.status(500).json({ error: 'Error serving file' });
    }
  });
}

function sendPlaceholderSvg(res, svg, cacheable) {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', cacheable ? 'public, max-age=86400' : 'no-cache');
  res.send(svg);
}

// Serve thumbnail images
app.get('/api/thumbnail/:filename(*)', async (req, res) => {
  try {
    const filename = decodeFilenameParam(req.params.filename);
    const filePath = path.join(BASE_PATH, filename);
    const fileType = getFileType(filename);
    const thumbnailPath = getThumbnailPath(filename);

    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(BASE_PATH);

    if (!resolvedPath.startsWith(resolvedBase)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const absoluteThumbnailPath = path.resolve(thumbnailPath);
    const longCache = 'public, max-age=604800, immutable';

    if (fs.existsSync(absoluteThumbnailPath)) {
      return sendCachedFile(res, absoluteThumbnailPath, longCache);
    }

    if (fileType === 'image' && sharp) {
      try {
        const generated = await ensureImageThumbnail(filename, resolvedPath, absoluteThumbnailPath);
        return sendCachedFile(res, generated, longCache);
      } catch (error) {
        console.error(`Error generating image thumbnail for ${filename}:`, error.message);
        return sendCachedFile(res, resolvedPath, 'public, max-age=3600');
      }
    }

    if (fileType === 'image') {
      return sendCachedFile(res, resolvedPath, 'public, max-age=3600');
    }

    if (fileType === 'pdf') {
      const pdfIconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
  <rect width="320" height="180" fill="#14161c"/>
  <rect x="100" y="40" width="120" height="100" fill="#e07a5f" rx="8"/>
  <text x="160" y="110" font-family="system-ui, sans-serif" font-size="36" font-weight="700" fill="white" text-anchor="middle">PDF</text>
</svg>`;
      return sendPlaceholderSvg(res, pdfIconSvg, true);
    }

    if (fileType === 'video') {
      const videoIconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
  <rect width="320" height="180" fill="#14161c"/>
  <circle cx="160" cy="90" r="36" fill="#f0b429"/>
  <polygon points="150,72 150,108 182,90" fill="#14161c"/>
</svg>`;
      return sendPlaceholderSvg(res, videoIconSvg, false);
    }

    if (!res.headersSent) {
      res.status(404).json({ error: 'Thumbnail not available for this file type' });
    }
  } catch (error) {
    console.error('Error serving thumbnail:', error);
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid filename' });
    }
  }
});

// Login page
app.get('/login', (req, res) => {
  // If already authenticated, redirect to home
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login API endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (verifyCredentials(username, password)) {
    const user = getOrCreateUser(username);
    req.session.authenticated = true;
    req.session.username = username;
    req.session.userId = user ? user.id : null;
    res.json({ success: true, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Error logging out' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  const user = getSessionUser(req);
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    username: req.session && req.session.username || null,
    favoriteCount: user ? getFavoriteCount(user.id) : 0
  });
});

app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user || !db) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const profile = db.prepare('SELECT username, created_at, last_login FROM users WHERE id = ?').get(user.id);
  res.json({
    username: user.username,
    createdAt: profile && profile.created_at ? profile.created_at * 1000 : null,
    lastLogin: profile && profile.last_login ? profile.last_login * 1000 : null,
    favoriteCount: getFavoriteCount(user.id)
  });
});

app.post('/api/favorites/toggle', (req, res) => {
  try {
    const user = getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const filename = req.body && req.body.filename;
    if (!filename) {
      return res.status(400).json({ error: 'filename is required' });
    }
    const file = db.prepare('SELECT id FROM files WHERE filename = ?').get(filename);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    const existing = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND file_id = ?').get(user.id, file.id);
    if (existing) {
      db.prepare('DELETE FROM favorites WHERE user_id = ? AND file_id = ?').run(user.id, file.id);
      return res.json({ favorited: false, favoriteCount: getFavoriteCount(user.id) });
    }
    db.prepare('INSERT INTO favorites (user_id, file_id) VALUES (?, ?)').run(user.id, file.id);
    res.json({ favorited: true, favoriteCount: getFavoriteCount(user.id) });
  } catch (error) {
    console.error('Error toggling favorite:', error);
    res.status(500).json({ error: 'Error updating favorite' });
  }
});

app.delete('/api/file/:filename(*)', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const filename = decodeFilenameParam(req.params.filename);
    const filePath = resolveLibraryPath(filename);
    if (!filePath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const record = db.prepare('SELECT id, filename FROM files WHERE filename = ?').get(filename);
    if (!record) {
      return res.status(404).json({ error: 'File not found' });
    }

    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          return res.status(403).json({ error: 'Access denied' });
        }
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('Error deleting media file:', error);
      return res.status(500).json({ error: 'Could not delete file from disk' });
    }

    const thumbnailPath = getThumbnailPath(filename);
    try {
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    } catch (error) {
      console.warn('Could not delete thumbnail:', error.message);
    }

    db.prepare('DELETE FROM files WHERE id = ?').run(record.id);

    try {
      removeFilenameFromFilelist(filename);
    } catch (error) {
      console.warn('Could not update filelist:', error.message);
    }

    res.json({ ok: true, filename });
  } catch (error) {
    console.error('Error removing file:', error);
    res.status(500).json({ error: 'Error removing file' });
  }
});

app.get('/api/favorites', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const rows = db.prepare(`
    SELECT f.filename
    FROM favorites fav
    JOIN files f ON f.id = fav.file_id
    WHERE fav.user_id = ?
    ORDER BY fav.created_at DESC
  `).all(user.id);
  res.json({
    filenames: rows.map(row => row.filename),
    favoriteCount: rows.length
  });
});

app.get('/api/actors', (req, res) => {
  try {
    if (!db) {
      return res.json({ actors: [] });
    }
    res.json({ actors: getActorsWithCounts() });
  } catch (error) {
    console.error('Error listing actors:', error);
    res.status(500).json({ error: 'Error listing actors' });
  }
});

app.post('/api/actors', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const name = normalizeActorName(req.body && req.body.name);
    if (name.length < 2) {
      return res.status(400).json({ error: 'Actor name must be at least 2 characters' });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: 'Actor name is too long' });
    }
    try {
      const result = db.prepare('INSERT INTO actors (name) VALUES (?)').run(name);
      const actor = db.prepare('SELECT id, name FROM actors WHERE id = ?').get(result.lastInsertRowid);
      res.json({ actor, actors: getActorsWithCounts() });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'That actor is already in the list' });
      }
      throw error;
    }
  } catch (error) {
    console.error('Error adding actor:', error);
    res.status(500).json({ error: 'Error adding actor' });
  }
});

app.put('/api/actors/:id', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid actor id' });
    }
    const existing = db.prepare('SELECT id FROM actors WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Actor not found' });
    }
    const name = normalizeActorName(req.body && req.body.name);
    if (name.length < 2) {
      return res.status(400).json({ error: 'Actor name must be at least 2 characters' });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: 'Actor name is too long' });
    }
    try {
      db.prepare('UPDATE actors SET name = ? WHERE id = ?').run(name, id);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'That actor is already in the list' });
      }
      throw error;
    }
    const actor = db.prepare('SELECT id, name FROM actors WHERE id = ?').get(id);
    res.json({ actor, actors: getActorsWithCounts() });
  } catch (error) {
    console.error('Error updating actor:', error);
    res.status(500).json({ error: 'Error updating actor' });
  }
});

app.delete('/api/actors/:id', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid actor id' });
    }
    const existing = db.prepare('SELECT id FROM actors WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Actor not found' });
    }
    db.prepare('DELETE FROM actors WHERE id = ?').run(id);
    res.json({ ok: true, actors: getActorsWithCounts() });
  } catch (error) {
    console.error('Error deleting actor:', error);
    res.status(500).json({ error: 'Error deleting actor' });
  }
});

// Face recognition API endpoints
if (faceService) {
  // Detect faces in an image
  app.post('/api/detect-faces/:filename(*)', async (req, res) => {
    try {
      const filename = decodeFilenameParam(req.params.filename);
      const result = await faceService.processImage(filename);
      res.json(result);
    } catch (error) {
      console.error('Face detection error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get all face groups
  app.get('/api/face-groups', (req, res) => {
    try {
      const groups = faceService.getFaceGroups();
      res.json(groups);
    } catch (error) {
      console.error('Error getting face groups:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get images in a specific face group
  app.get('/api/face-group/:groupId', (req, res) => {
    try {
      const images = faceService.getGroupImages(req.params.groupId);
      res.json({ 
        groupId: req.params.groupId, 
        images,
        count: images.length
      });
    } catch (error) {
      console.error('Error getting face group:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Batch process images for face detection
  app.post('/api/process-faces', async (req, res) => {
    try {
      const { filenames } = req.body;
      if (!Array.isArray(filenames)) {
        return res.status(400).json({ error: 'filenames must be an array' });
      }

      // Process in background and return immediately
      res.json({ message: 'Processing started', count: filenames.length });
      
      // Process asynchronously
      faceService.processImages(filenames, (current, total, filename) => {
        console.log(`Face processing: ${current}/${total} - ${filename}`);
      }).catch(error => {
        console.error('Batch face processing error:', error);
      });
    } catch (error) {
      console.error('Error starting face processing:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

// API endpoint to get a single video and related videos
app.get('/api/video-info/:filename(*)', (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const filename = decodeFilenameParam(req.params.filename);
    const current = db.prepare(`
      SELECT id, filename, file_type, display_name, date, date_source, resolution
      FROM files WHERE filename = ?
    `).get(filename);

    if (!current) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const user = getSessionUser(req);
    const [currentVideo] = attachActors(attachFavoriteFlags(attachStems([current]), user && user.id));

    const relatedRows = db.prepare(`
      SELECT f.id, f.filename, f.file_type, f.display_name, f.date, f.date_source, f.resolution,
             COUNT(s.stem) AS similarityScore
      FROM files f
      JOIN stems s ON f.id = s.file_id
      WHERE f.id != ? AND f.file_type = ?
        AND s.stem IN (SELECT stem FROM stems WHERE file_id = ?)
      GROUP BY f.id
      ORDER BY similarityScore DESC
      LIMIT 20
    `).all(current.id, current.file_type, current.id);

    const relatedVideos = attachActors(attachFavoriteFlags(attachStems(relatedRows), user && user.id)).map((video, i) => ({
      ...video,
      similarityScore: relatedRows[i].similarityScore,
      sharedStems: []
    }));

    res.json({
      video: currentVideo,
      relatedVideos
    });
  } catch (error) {
    console.error('Error getting video info:', error);
    res.status(500).json({ error: 'Error getting video info' });
  }
});

// Serve the video page
// This route must come after static file serving to avoid conflicts
app.get('/video/:filename(*)', (req, res) => {
  const filename = req.params.filename;
  
  // Don't serve HTML page for static file requests (CSS, JS, etc.)
  // These should be handled by express.static above
  if (filename.endsWith('.css') || filename.endsWith('.js') || filename.endsWith('.png') || 
      filename.endsWith('.jpg') || filename.endsWith('.gif') || filename.endsWith('.ico')) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

// Serve the image page
app.get('/image/:filename(*)', (req, res) => {
  const filename = req.params.filename;
  
  // Don't serve HTML page for static file requests (CSS, JS, etc.)
  // These should be handled by express.static above
  if (filename.endsWith('.css') || filename.endsWith('.js') || filename.endsWith('.ico')) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Serve the image.html page - the actual image will be loaded via API in image.js
  res.sendFile(path.join(__dirname, 'public', 'image.html'));
});

// Serve the PDF page
app.get('/pdf/:filename(*)', (req, res) => {
  const filename = req.params.filename;
  
  // Don't serve HTML page for static file requests (CSS, JS, etc.)
  // These should be handled by express.static above
  if (filename.endsWith('.css') || filename.endsWith('.js') || filename.endsWith('.ico')) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Serve the pdf.html page - the actual PDF will be loaded via API in pdf.js
  res.sendFile(path.join(__dirname, 'public', 'pdf.html'));
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Start the server
app.listen(PORT, () => {
  // Initialize database
  initializeDatabase();

  // Scan media path and populate database
  scanAndPopulateDatabase();

  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Media path: ${BASE_PATH}`);
  console.log(`Database: ${DB_FILE}`);

  // Run background jobs one at a time so the Pi is not overloaded
  (async () => {
    try {
      await detectAllVideoResolutions();
      await generateMissingThumbnails();
      await deduplicateFiles();
    } catch (error) {
      console.error('Error during startup maintenance:', error);
    }
  })();
});


