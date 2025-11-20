const faceapi = require('face-api.js');
const { Canvas, Image, ImageData } = require('canvas');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Configure face-api.js to use canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

class FaceRecognitionService {
  constructor(basePath, facesDir) {
    this.basePath = basePath;
    this.facesDir = facesDir;
    this.modelsLoaded = false;
    this.faceGroups = new Map(); // Map of faceId -> [image filenames]
    this.faceEmbeddings = new Map(); // Map of filename -> [embeddings]
    
    // Create faces directory if it doesn't exist
    if (!fs.existsSync(facesDir)) {
      fs.mkdirSync(facesDir, { recursive: true });
    }
    
    // Load face groups from disk
    this.loadFaceGroups();
  }

  /**
   * Load TensorFlow.js face detection models
   */
  async loadModels() {
    if (this.modelsLoaded) return;
    
    const modelsPath = path.join(__dirname, 'models');
    
    // Download models if they don't exist
    if (!fs.existsSync(modelsPath)) {
      console.log('Models not found. Please download face-api.js models.');
      console.log('Run: npm run download-models');
      throw new Error('Face detection models not found');
    }

    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
    
    this.modelsLoaded = true;
    console.log('Face detection models loaded');
  }

  /**
   * Detect faces in an image and extract embeddings
   */
  async detectFaces(imagePath) {
    if (!this.modelsLoaded) {
      await this.loadModels();
    }

    try {
      // Load image using canvas
      const imageBuffer = await fs.promises.readFile(imagePath);
      
      // Convert to canvas-compatible format
      const img = await sharp(imageBuffer)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      
      const imgElement = new Image();
      imgElement.src = img;
      
      // Wait for image to load
      await new Promise((resolve, reject) => {
        imgElement.onload = resolve;
        imgElement.onerror = reject;
      });

      // Detect faces with landmarks
      const detections = await faceapi
        .detectAllFaces(imgElement)
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (detections.length === 0) {
        return { faces: [], count: 0 };
      }

      // Extract embeddings (descriptors)
      const embeddings = detections.map(detection => ({
        embedding: Array.from(detection.descriptor),
        box: {
          x: detection.detection.box.x,
          y: detection.detection.box.y,
          width: detection.detection.box.width,
          height: detection.detection.box.height
        }
      }));

      return {
        faces: embeddings,
        count: embeddings.length
      };
    } catch (error) {
      console.error(`Error detecting faces in ${imagePath}:`, error);
      throw error;
    }
  }

  /**
   * Calculate similarity between two face embeddings (cosine similarity)
   */
  cosineSimilarity(embedding1, embedding2) {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (norm1 * norm2);
  }

  /**
   * Match a face embedding against known faces
   * Returns the face group ID if match found, null otherwise
   */
  matchFace(embedding, threshold = 0.6) {
    let bestMatch = null;
    let bestSimilarity = threshold;

    // Check against all existing face groups
    for (const [faceId, groupData] of this.faceGroups.entries()) {
      const referenceEmbedding = groupData.referenceEmbedding;
      const similarity = this.cosineSimilarity(embedding, referenceEmbedding);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = faceId;
      }
    }

    return bestMatch ? { faceId: bestMatch, similarity: bestSimilarity } : null;
  }

  /**
   * Process an image and group it with similar faces
   */
  async processImage(filename) {
    const imagePath = path.join(this.basePath, filename);
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image not found: ${imagePath}`);
    }

    // Check if already processed
    const faceDataPath = path.join(this.facesDir, `${filename.replace(/\//g, '_')}.json`);
    if (fs.existsSync(faceDataPath)) {
      const cached = JSON.parse(fs.readFileSync(faceDataPath, 'utf8'));
      return cached;
    }

    // Detect faces
    const detectionResult = await this.detectFaces(imagePath);
    
    if (detectionResult.count === 0) {
      // Save empty result
      const result = { filename, faces: [], groups: [] };
      fs.writeFileSync(faceDataPath, JSON.stringify(result, null, 2));
      return result;
    }

    // Match each face to existing groups or create new groups
    const groups = [];
    
    for (const face of detectionResult.faces) {
      const match = this.matchFace(face.embedding);
      
      if (match) {
        // Add to existing group
        const groupId = match.faceId;
        if (!this.faceGroups.has(groupId)) {
          this.faceGroups.set(groupId, {
            referenceEmbedding: face.embedding,
            images: []
          });
        }
        
        const group = this.faceGroups.get(groupId);
        if (!group.images.includes(filename)) {
          group.images.push(filename);
        }
        groups.push({ groupId, similarity: match.similarity });
      } else {
        // Create new group
        const groupId = `face_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.faceGroups.set(groupId, {
          referenceEmbedding: face.embedding,
          images: [filename]
        });
        groups.push({ groupId, similarity: 1.0 });
      }
    }

    // Save face data
    const result = {
      filename,
      faces: detectionResult.faces.map(f => ({
        box: f.box,
        embedding: f.embedding // Store for future matching
      })),
      groups: groups
    };
    
    fs.writeFileSync(faceDataPath, JSON.stringify(result, null, 2));
    
    // Save updated face groups
    this.saveFaceGroups();
    
    return result;
  }

  /**
   * Get all face groups
   */
  getFaceGroups() {
    const groups = [];
    for (const [groupId, groupData] of this.faceGroups.entries()) {
      groups.push({
        id: groupId,
        imageCount: groupData.images.length,
        images: groupData.images
      });
    }
    return groups;
  }

  /**
   * Get images for a specific face group
   */
  getGroupImages(groupId) {
    const group = this.faceGroups.get(groupId);
    return group ? group.images : [];
  }

  /**
   * Load face groups from disk
   */
  loadFaceGroups() {
    const groupsFile = path.join(this.facesDir, 'face-groups.json');
    if (fs.existsSync(groupsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(groupsFile, 'utf8'));
        for (const [groupId, groupData] of Object.entries(data)) {
          this.faceGroups.set(groupId, groupData);
        }
      } catch (error) {
        console.error('Error loading face groups:', error);
      }
    }
  }

  /**
   * Save face groups to disk
   */
  saveFaceGroups() {
    const groupsFile = path.join(this.facesDir, 'face-groups.json');
    const data = {};
    for (const [groupId, groupData] of this.faceGroups.entries()) {
      data[groupId] = groupData;
    }
    fs.writeFileSync(groupsFile, JSON.stringify(data, null, 2));
  }

  /**
   * Batch process multiple images
   */
  async processImages(filenames, progressCallback) {
    const results = [];
    const total = filenames.length;
    
    for (let i = 0; i < filenames.length; i++) {
      try {
        const result = await this.processImage(filenames[i]);
        results.push(result);
        
        if (progressCallback) {
          progressCallback(i + 1, total, filenames[i]);
        }
      } catch (error) {
        console.error(`Error processing ${filenames[i]}:`, error);
        results.push({ filename: filenames[i], error: error.message });
      }
    }
    
    return results;
  }
}

module.exports = FaceRecognitionService;

