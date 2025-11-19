const express = require('express');
const fs = require('fs');
const path = require('path');
const natural = require('natural');
const ffmpeg = require('fluent-ffmpeg');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;

// Base path for video files - will be loaded from config
let BASE_PATH = '/srv/nas/research/p/';
const FILELIST_PATH = path.join(__dirname, 'filelist.txt');
const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.txt');
const CONFIG_FILE = path.join(__dirname, 'config.json');

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
      const thumbnailPath = getThumbnailPath(file);
      
      // Get resolution from resolution files
      const resolution = getVideoResolutionFromFiles(file);
      
      return {
        filename: file,
        fullPath: `/api/video/${file}`, // Use API endpoint instead of direct path
        thumbnailPath: `/api/thumbnail/${encodeURIComponent(file)}`,
        displayName: path.basename(file),
        stems: stems,
        resolution: resolution
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
  
  let videos = getVideoList();
  
  // Filter by resolution if provided
  if (resolutionFilter) {
    // Get videos from the resolution file
    const resolutionVideos = loadVideosForResolution(resolutionFilter);
    const resolutionSet = new Set(resolutionVideos);
    videos = videos.filter(video => resolutionSet.has(video.filename));
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
  
  // Randomize videos on the first page only (when no filters are applied)
  if (page === 1 && !stemFilter && !resolutionFilter) {
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
  const videoPath = path.join(BASE_PATH, filename);
  
  // Security check
  const resolvedPath = path.resolve(videoPath);
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
  getVideoResolution(videoPath, (err, result) => {
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

// Serve video files
app.get('/api/video/:filename(*)', (req, res) => {
  const filename = req.params.filename;
  const videoPath = path.join(BASE_PATH, filename);
  
  // Security check: ensure the path is within BASE_PATH
  const resolvedPath = path.resolve(videoPath);
  const resolvedBase = path.resolve(BASE_PATH);
  
  if (!resolvedPath.startsWith(resolvedBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  // Serve the video file (resolvedPath is already absolute)
  res.sendFile(resolvedPath);
});

// Serve thumbnail images
app.get('/api/thumbnail/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const videoPath = path.join(BASE_PATH, filename);
  const thumbnailPath = getThumbnailPath(filename);
  
  // Security check: ensure the path is within BASE_PATH
  const resolvedPath = path.resolve(videoPath);
  const resolvedBase = path.resolve(BASE_PATH);
  
  if (!resolvedPath.startsWith(resolvedBase)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  // Check if video file exists
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  // Resolve thumbnail path to absolute
  const absoluteThumbnailPath = path.resolve(thumbnailPath);
  
  // Helper function to check if response is still writable
  function isResponseWritable(res) {
    return !res.headersSent && !res.writableEnded && !res.destroyed;
  }
  
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
  
  // Otherwise, generate thumbnail on-the-fly
  generateThumbnail(videoPath, thumbnailPath, (err, generatedPath) => {
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

// API endpoint to get a single video and related videos
app.get('/api/video-info/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const videos = getVideoList();
  
  // Find the current video
  const currentVideo = videos.find(v => v.filename === filename);
  
  if (!currentVideo) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  // Find related videos based on shared stems
  const relatedVideos = videos
    .filter(v => v.filename !== filename) // Exclude current video
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
    .filter(video => video.similarityScore > 0) // Only videos with at least one shared stem
    .sort((a, b) => b.similarityScore - a.similarityScore) // Sort by similarity
    .slice(0, 20); // Limit to 20 related videos
  
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

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Base path: ${BASE_PATH}`);
  console.log(`Filelist: ${FILELIST_PATH}`);
});

