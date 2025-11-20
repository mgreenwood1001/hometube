# Face Recognition Feature

This feature automatically detects faces in images and groups photos that contain the same person together.

## Installation

### 1. Install Optional Dependencies

The face recognition dependencies are marked as optional, so they won't break your installation if they fail. To install them:

```bash
npm install face-api.js @tensorflow/tfjs-node canvas sharp
```

**Note**: `canvas` may require system dependencies:
- **macOS**: `brew install pkg-config cairo pango libpng jpeg giflib librsvg`
- **Ubuntu/Debian**: `sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
- **Windows**: See [node-canvas installation guide](https://github.com/Automattics/node-canvas/wiki/Installation:-Windows)

### 2. Download Face Detection Models

Download the required TensorFlow.js models:

```bash
npm run download-models
```

This will create a `models/` directory with the face detection models (~25MB total).

## Usage

### API Endpoints

Once installed, the following endpoints are available:

#### Detect Faces in an Image
```bash
POST /api/detect-faces/:filename
```

Processes an image and detects faces. Returns face data and groups.

**Example:**
```javascript
fetch('/api/detect-faces/photos/vacation.jpg', { method: 'POST' })
  .then(res => res.json())
  .then(data => console.log(data));
```

**Response:**
```json
{
  "filename": "photos/vacation.jpg",
  "faces": [
    {
      "box": { "x": 100, "y": 150, "width": 200, "height": 250 },
      "embedding": [0.123, 0.456, ...] // 128-dimensional vector
    }
  ],
  "groups": [
    { "groupId": "face_1234567890_abc", "similarity": 0.85 }
  ]
}
```

#### Get All Face Groups
```bash
GET /api/face-groups
```

Returns all detected face groups with image counts.

**Response:**
```json
[
  {
    "id": "face_1234567890_abc",
    "imageCount": 5,
    "images": ["photo1.jpg", "photo2.jpg", ...]
  }
]
```

#### Get Images in a Face Group
```bash
GET /api/face-group/:groupId
```

Returns all images that contain a specific face.

**Response:**
```json
{
  "groupId": "face_1234567890_abc",
  "images": ["photo1.jpg", "photo2.jpg", "photo3.jpg"],
  "count": 3
}
```

#### Batch Process Images
```bash
POST /api/process-faces
Content-Type: application/json

{
  "filenames": ["photo1.jpg", "photo2.jpg", "photo3.jpg"]
}
```

Starts background processing of multiple images. Returns immediately.

## How It Works

1. **Face Detection**: Uses SSD MobileNet v1 to detect faces in images
2. **Face Embedding**: Extracts 128-dimensional feature vectors for each face
3. **Face Matching**: Uses cosine similarity to match faces (threshold: 0.6)
4. **Grouping**: Groups images containing the same person together
5. **Caching**: Face data is cached in `faces/` directory to avoid reprocessing

## Performance

- **Processing Time**: ~1-3 seconds per image (depends on image size and CPU)
- **Memory**: Models load ~100MB into memory
- **Storage**: Face embeddings stored in JSON files (~10-50KB per image)

## Data Storage

- **Face Data**: `faces/{filename}.json` - Individual image face data
- **Face Groups**: `faces/face-groups.json` - All face groups and their images

## Integration with UI

To integrate face recognition into your UI:

1. Add a "Face Groups" filter/section
2. Display grouped photos together
3. Show face count per group
4. Allow filtering by face group

Example frontend code:
```javascript
// Get all face groups
const groups = await fetch('/api/face-groups').then(r => r.json());

// Filter images by face group
const groupImages = await fetch(`/api/face-group/${groupId}`).then(r => r.json());
```

## Troubleshooting

### Models Not Found
If you see "Face detection models not found":
1. Run `npm run download-models`
2. Ensure `models/` directory exists with all model files

### Canvas Installation Issues
If `canvas` fails to install:
- Install system dependencies (see Installation section)
- On Linux, you may need to install `poppler-utils` for PDF support

### Performance Issues
- Process images in batches
- Use background processing for large collections
- Consider processing only on-demand (when images are viewed)

## Optional Feature

Face recognition is completely optional. If dependencies aren't installed, the server will start normally without face recognition features. The service gracefully degrades if models aren't available.

