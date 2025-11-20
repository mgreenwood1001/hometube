#!/usr/bin/env node

const express = require('express');
const fs = require('fs');
const path = require('path');
const natural = require('natural');
const ffmpeg = require('fluent-ffmpeg');
const session = require('express-session');
const cookieParser = require('cookie-parser');

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

// Create thumbnails directory if it doesn't exist
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
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

// Authentication middleware
function requireAuth(req, res, next) {
  // Allow access to login page, login API, and config API without authentication
  if (req.path === '/login' || req.path === '/api/login' || req.path === '/api/auth/status' || req.path === '/api/config') {
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
      
      // Update BASE_PATH if specified in config
      if (config.videoBasePath) {
        BASE_PATH = config.videoBasePath;
        // Ensure it ends with a slash
        if (!BASE_PATH.endsWith('/')) {
          BASE_PATH += '/';
        }
      }
      
      return {
        systemName: config.systemName || 'HomeTube',
        videoBasePath: BASE_PATH
      };
    }
  } catch (error) {
    console.error('Error loading config file:', error);
  }
  
  // Default values
  return {
    systemName: 'HomeTube',
    videoBasePath: BASE_PATH
  };
}

let appConfig = loadConfig();

// Also allow environment variable to override (for backward compatibility)
if (process.env.BASE_PATH) {
  BASE_PATH = process.env.BASE_PATH;
  if (!BASE_PATH.endsWith('/')) {
    BASE_PATH += '/';
  }
  appConfig.videoBasePath = BASE_PATH;
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
app.use(express.static('public'));

// Stemmer instance
const stemmer = natural.PorterStemmer;

// Helper function to generate thumbnail filename
function getThumbnailPath(filename) {
  // Create a safe filename for the thumbnail
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(THUMBNAILS_DIR, `${safeName}.jpg`);
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
  
  // Extract frame at 10% of video duration
  // Use .input() to explicitly set the input file
  ffmpeg()
    .input(absoluteVideoPath)
    .screenshots({
      timestamps: ['10%'],
      filename: path.basename(absoluteThumbnailPath),
      folder: path.dirname(absoluteThumbnailPath),
      size: '320x180'
    })
    .on('end', () => {
      callback(null, absoluteThumbnailPath);
    })
    .on('error', (err) => {
      console.error(`Error generating thumbnail for ${absoluteVideoPath}:`, err.message);
      callback(err, null);
    });
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


// Read and parse filelist
function getVideoList() {
  try {
    if (!fs.existsSync(FILELIST_PATH)) {
      return [];
    }
    
    const content = fs.readFileSync(FILELIST_PATH, 'utf-8');
    const files = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    return files.map(file => {
      const fullPath = path.join(BASE_PATH, file);
      const stems = extractStems(file);
      const fileType = getFileType(file);
      const thumbnailPath = getThumbnailPath(file);
      
      // Get resolution from resolution files (only for videos)
      const resolution = fileType === 'video' ? getVideoResolutionFromFiles(file) : null;
      
      // Get file date (from metadata or file modification time)
      const dateInfo = getFileDateSync(file);
      
      return {
        filename: file,
        fullPath: `/api/video/${file}`, // Use API endpoint instead of direct path
        thumbnailPath: `/api/thumbnail/${encodeURIComponent(file)}`,
        displayName: path.basename(file),
        stems: stems,
        resolution: resolution,
        fileType: fileType,
        date: dateInfo.date,
        dateSource: dateInfo.source
      };
    });
  } catch (error) {
    console.error('Error reading filelist:', error);
    return [];
  }
}

// API endpoint to get videos with pagination and filtering
app.get('/api/videos', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const stemFilter = req.query.stem || null;
  const filterMode = req.query.mode || 'OR'; // 'AND' or 'OR'
  const resolutionFilter = req.query.resolution || null;
  const fileTypeFilter = req.query.fileType || null; // 'video', 'pdf', 'image', or null for all
  const dateFrom = req.query.dateFrom || null; // ISO date string
  const dateTo = req.query.dateTo || null; // ISO date string
  
  let videos = getVideoList();
  
  // Filter by file type if provided
  if (fileTypeFilter && fileTypeFilter !== 'all') {
    videos = videos.filter(video => video.fileType === fileTypeFilter);
  }
  
  // Filter by resolution if provided (only for videos)
  if (resolutionFilter) {
    // Get videos from the resolution file
    const resolutionVideos = loadVideosForResolution(resolutionFilter);
    const resolutionSet = new Set(resolutionVideos);
    videos = videos.filter(video => 
      video.fileType === 'video' && resolutionSet.has(video.filename)
    );
  }
  
  // Filter by stem(s) if provided
  if (stemFilter) {
    // Parse multiple stems (comma-separated or space-separated with AND/OR)
    const stems = stemFilter.toLowerCase().split(',').map(s => s.trim()).filter(s => s);
    
    if (stems.length > 0) {
      if (filterMode.toUpperCase() === 'AND') {
        // All stems must be present (AND logic)
        videos = videos.filter(video => 
          stems.every(stem => video.stems.includes(stem))
        );
      } else {
        // At least one stem must be present (OR logic - default)
        videos = videos.filter(video => 
          stems.some(stem => video.stems.includes(stem))
        );
      }
    }
  }
  
  // Filter by date range if provided
  if (dateFrom || dateTo) {
    videos = videos.filter(video => {
      const videoDate = new Date(video.date);
      if (dateFrom && videoDate < new Date(dateFrom)) {
        return false;
      }
      if (dateTo) {
        // Include the entire end date (set to end of day)
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        if (videoDate > endDate) {
          return false;
        }
      }
      return true;
    });
  }
  
  // Sort by date (newest first) when date filtering is active
  if (dateFrom || dateTo) {
    videos.sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  
  // Randomize videos on the first page only (when no filters are applied)
  if (page === 1 && !stemFilter && !resolutionFilter && !fileTypeFilter && !dateFrom && !dateTo) {
    // Fisher-Yates shuffle algorithm
    for (let i = videos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [videos[i], videos[j]] = [videos[j], videos[i]];
    }
  }
  
  // Calculate pagination
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  const paginatedVideos = videos.slice(startIndex, endIndex);
  const totalPages = Math.ceil(videos.length / limit);
  
  res.json({
    videos: paginatedVideos,
    pagination: {
      currentPage: page,
      totalPages: totalPages,
      totalVideos: videos.length,
      limit: limit
    }
  });
});

// API endpoint to get date range (min and max dates)
app.get('/api/date-range', (req, res) => {
  const videos = getVideoList();
  
  if (videos.length === 0) {
    return res.json({ minDate: null, maxDate: null });
  }
  
  const dates = videos.map(v => new Date(v.date)).filter(d => !isNaN(d.getTime()));
  
  if (dates.length === 0) {
    return res.json({ minDate: null, maxDate: null });
  }
  
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));
  
  res.json({
    minDate: minDate.toISOString(),
    maxDate: maxDate.toISOString()
  });
});

// API endpoint to get file counts per date
app.get('/api/date-counts', (req, res) => {
  const videos = getVideoList();
  const dateCounts = {};
  
  videos.forEach(video => {
    if (video.date) {
      // Get date as YYYY-MM-DD (without time)
      const date = new Date(video.date);
      const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      dateCounts[dateKey] = (dateCounts[dateKey] || 0) + 1;
    }
  });
  
  res.json({ dateCounts });
});

// API endpoint to get all unique stems
app.get('/api/stems', (req, res) => {
  const videos = getVideoList();
  const stemCounts = {};
  
  videos.forEach(video => {
    video.stems.forEach(stem => {
      stemCounts[stem] = (stemCounts[stem] || 0) + 1;
    });
  });
  
  // Convert to array and sort by count
  const stems = Object.entries(stemCounts)
    .map(([stem, count]) => ({ stem, count }))
    .sort((a, b) => b.count - a.count);
  
  res.json({ stems });
});

// API endpoint to get all unique resolutions
app.get('/api/resolutions', (req, res) => {
  // Return all predefined resolutions with counts (even if 0)
  const resolutions = RESOLUTIONS.map(resolution => {
    const videos = loadVideosForResolution(resolution);
    return {
      resolution: resolution,
      count: videos.length
    };
  });
  
  res.json({ resolutions });
});

// API endpoint to detect and save video resolution
app.get('/api/detect-resolution/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
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
  
  // Check if already processed
  const existingResolution = getVideoResolutionFromFiles(filename);
  if (existingResolution !== 'Unknown') {
    return res.json({ resolution: existingResolution, cached: true });
  }
  
  // Detect resolution
  getVideoResolution(filePath, (err, result) => {
    if (err) {
      console.error('Error detecting resolution:', err);
      return res.json({ resolution: 'Unknown', error: err.message });
    }
    
    // Remove from other resolution files (in case it was moved)
    for (const res of RESOLUTIONS) {
      const videos = loadVideosForResolution(res);
      const index = videos.indexOf(filename);
      if (index > -1) {
        videos.splice(index, 1);
        const resolutionFile = path.join(RESOLUTIONS_DIR, `${res}.txt`);
        fs.writeFileSync(resolutionFile, videos.join('\n') + (videos.length > 0 ? '\n' : ''));
      }
    }
    
    // Save to the correct resolution file
    saveVideoToResolution(filename, result.resolution);
    
    res.json({ resolution: result.resolution, cached: false });
  });
});

// Serve video and PDF files
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
  
  // Set appropriate content type
  const fileType = getFileType(filename);
  if (fileType === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
  }
  
  // Serve the file (resolvedPath is already absolute)
  res.sendFile(resolvedPath);
});

// Serve thumbnail images
app.get('/api/thumbnail/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(BASE_PATH, filename);
  const fileType = getFileType(filename);
  const thumbnailPath = getThumbnailPath(filename);
  
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
  
  // Helper function to check if response is still writable
  function isResponseWritable(res) {
    return !res.headersSent && !res.writableEnded && !res.destroyed;
  }
  
  // For images, serve the image file directly as thumbnail
  if (fileType === 'image') {
    return res.sendFile(resolvedPath, (err) => {
      if (err) {
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
          console.log(`Client disconnected while sending image: ${resolvedPath}`);
          return;
        }
        console.error(`Error sending image file ${resolvedPath}:`, err);
        if (isResponseWritable(res)) {
          res.status(500).json({ error: 'Error serving image' });
        }
      }
    });
  }
  
  // Resolve thumbnail path to absolute
  const absoluteThumbnailPath = path.resolve(thumbnailPath);
  
  // If thumbnail exists, serve it
  if (fs.existsSync(absoluteThumbnailPath)) {
    return res.sendFile(absoluteThumbnailPath, (err) => {
      if (err) {
        // ECONNABORTED means client disconnected - this is normal, don't log as error
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
          console.log(`Client disconnected while sending thumbnail: ${absoluteThumbnailPath}`);
          return;
        }
        console.error(`Error sending thumbnail file ${absoluteThumbnailPath}:`, err);
        if (isResponseWritable(res)) {
          res.status(500).json({ error: 'Error serving thumbnail' });
        }
      }
    });
  }
  
  // For PDFs, serve placeholder SVG icon
  // PDF thumbnail generation is disabled to avoid crashes
  if (fileType === 'pdf') {
    const pdfIconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="320" height="180" xmlns="http://www.w3.org/2000/svg">
  <rect width="320" height="180" fill="#1a1a1a"/>
  <rect x="100" y="40" width="120" height="100" fill="#dc2626" rx="4"/>
  <text x="160" y="110" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="white" text-anchor="middle">PDF</text>
  <text x="160" y="160" font-family="Arial, sans-serif" font-size="12" fill="#aaaaaa" text-anchor="middle">Document</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(pdfIconSvg);
  }
  
  // For videos, generate thumbnail on-the-fly
  if (fileType === 'video') {
    generateThumbnail(filePath, thumbnailPath, (err, generatedPath) => {
      if (err) {
        // If thumbnail generation fails, return a placeholder or error
        console.error('Thumbnail generation error:', err);
        if (isResponseWritable(res)) {
          return res.status(500).json({ error: 'Failed to generate thumbnail' });
        }
        return;
      }
      
      // Serve the newly generated thumbnail (generatedPath is already absolute)
      if (generatedPath && fs.existsSync(generatedPath)) {
        res.sendFile(generatedPath, (err) => {
          if (err) {
            // ECONNABORTED means client disconnected - this is normal, don't log as error
            if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
              console.log(`Client disconnected while sending generated thumbnail: ${generatedPath}`);
              return;
            }
            console.error(`Error sending generated thumbnail ${generatedPath}:`, err);
            if (isResponseWritable(res)) {
              res.status(500).json({ error: 'Error serving generated thumbnail' });
            }
          }
        });
      } else {
        console.error(`Generated thumbnail not found: ${generatedPath}`);
        if (isResponseWritable(res)) {
          res.status(500).json({ error: 'Thumbnail file not found after generation' });
        }
      }
    });
  } else {
    // Unknown file type, return 404
    if (isResponseWritable(res)) {
      res.status(404).json({ error: 'Thumbnail not available for this file type' });
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
    req.session.authenticated = true;
    req.session.username = username;
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
  res.json({
    authenticated: req.session && req.session.authenticated || false,
    username: req.session && req.session.username || null
  });
});

// Face recognition API endpoints
if (faceService) {
  // Detect faces in an image
  app.post('/api/detect-faces/:filename(*)', async (req, res) => {
    try {
      const filename = decodeURIComponent(req.params.filename);
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
  const filename = decodeURIComponent(req.params.filename);
  const videos = getVideoList();
  
  // Find the current video
  const currentVideo = videos.find(v => v.filename === filename);
  
  if (!currentVideo) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  // Find related items based on shared stems, filtered by same file type
  const relatedVideos = videos
    .filter(v => v.filename !== filename) // Exclude current item
    .filter(v => v.fileType === currentVideo.fileType) // Only same file type
    .map(video => {
      // Calculate similarity score based on shared stems
      const sharedStems = video.stems.filter(stem => 
        currentVideo.stems.includes(stem)
      );
      const similarityScore = sharedStems.length;
      
      return {
        ...video,
        similarityScore,
        sharedStems
      };
    })
    .filter(video => video.similarityScore > 0) // Only items with at least one shared stem
    .sort((a, b) => b.similarityScore - a.similarityScore) // Sort by similarity
    .slice(0, 20); // Limit to 20 related items
  
  res.json({
    video: currentVideo,
    relatedVideos
  });
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

// Start the server
app.listen(PORT, () => {
  // Load date cache on startup (before indexing)
  loadDateCache();
  
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Base path: ${BASE_PATH}`);
  console.log(`Filelist: ${FILELIST_PATH}`);
  
  // Index all file dates on startup (async, non-blocking, after server starts)
  indexAllFileDates().catch(error => {
    console.error('Error during startup date indexing:', error);
  });
});


