# HomeTube - Video Browser

A YouTube-like video browser built with Node.js that lists videos from a file list, supports word stemming, and provides pagination.

## Installation

### Via npm (Recommended)

```bash
npm install -g @mgreenwood1001/hometube
```

Then run:
```bash
hometube
```

### Manual Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/mgreenwood1001/hometube.git
cd hometube
npm install
```

## Features

- 🔐 Password protection with username/password authentication
- 📺 YouTube-like interface
- 📄 Reads videos from `filelist.txt`
- 🖼️ Automatic video thumbnail generation
- 🎬 Professional video player with Video.js (playback controls, speed adjustment, fullscreen)
- 🔍 Word stemming from filenames
- 🏷️ Clickable stem tags to filter videos
- 📑 Pagination support
- 🔎 Search functionality with AND/OR logic
- 📊 Video resolution detection and filtering
- 📁 Support for videos, images, and PDF documents

## Quick Setup

### Automated Setup (Recommended)

Use the provided script to automatically scan a directory and generate `filelist.txt` and `config.json`:

```bash
./seed-media.sh /path/to/your/media/files
```

This script will:
- Scan the directory recursively for videos, images, and PDFs
- Generate `filelist.txt` with all found files (relative paths)
- Create/update `config.json` with the media directory path

## Setup

1. Install FFmpeg (required for thumbnail generation):
   - **macOS**: `brew install ffmpeg`
   - **Ubuntu/Debian**: `sudo apt-get install ffmpeg`
   - **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

2. Install dependencies:
```bash
npm install
```

3. Set up credentials:
   - Edit `credentials.txt` and add your username:password pairs (one per line)
   - Format: `username:password`
   - Lines starting with `#` are treated as comments
   - Example:
     ```
     admin:mysecretpassword
     user:anotherpassword
     ```

4. Configure the base path and file list:
   - **Option A (Recommended)**: Use the seed script:
     ```bash
     ./seed-media.sh /path/to/your/media/files
     ```
     This automatically creates `filelist.txt` and `config.json`.
   
   - **Option B (Manual)**: 
     - Edit `config.json` and set the `videoBasePath` to your media directory
     - Create `filelist.txt` with one filename per line (relative to `videoBasePath`)

5. Start the server:
```bash
npm start
```

6. Open your browser and navigate to:
   - You will be redirected to the login page
   - Enter your username and password from `credentials.txt`
```
http://localhost:3000
```

## How it works

- The server reads `filelist.txt` and processes each filename
- Video thumbnails are automatically generated using FFmpeg (extracted at 10% of video duration)
- Thumbnails are cached in the `thumbnails/` directory for fast loading
- Words are extracted from filenames and stemmed using the Porter Stemmer algorithm
- The frontend displays videos in a grid layout similar to YouTube with actual video frames
- Click on any video thumbnail to play it in a full-screen modal with Video.js player
- The video player supports playback speed control, fullscreen, and all standard video controls
- Click on any stem tag in the sidebar to filter videos by that stem
- Use pagination controls to navigate through pages of videos
- Use the search box to find and filter by stems

## Configuration

- **BASE_PATH**: The base directory where your video files are stored
- **PORT**: Server port (default: 3000)
- **videosPerPage**: Number of videos per page (default: 12, set in `public/app.js`)
- **SESSION_SECRET**: Secret key for session encryption (set via environment variable, defaults to a placeholder)
- **credentials.txt**: Username/password file (format: `username:password`, one per line)

```

