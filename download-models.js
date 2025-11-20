#!/usr/bin/env node

/**
 * Script to download face-api.js models
 * Run: node download-models.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, 'models');
const models = [
  {
    name: 'ssd_mobilenetv1_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/ssd_mobilenetv1_model-weights_manifest.json'
  },
  {
    name: 'ssd_mobilenetv1_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/ssd_mobilenetv1_model-shard1'
  },
  {
    name: 'face_landmark_68_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_model-weights_manifest.json'
  },
  {
    name: 'face_landmark_68_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_model-shard1'
  },
  {
    name: 'face_recognition_model-weights_manifest.json',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-weights_manifest.json'
  },
  {
    name: 'face_recognition_model-shard1',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-shard1'
  },
  {
    name: 'face_recognition_model-shard2',
    url: 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-shard2'
  }
];

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        return downloadFile(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

async function downloadModels() {
  // Create models directory
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  console.log('Downloading face-api.js models...');
  console.log('This may take a few minutes...\n');

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const filepath = path.join(modelsDir, model.name);
    
    // Skip if already exists
    if (fs.existsSync(filepath)) {
      console.log(`[${i + 1}/${models.length}] Skipping ${model.name} (already exists)`);
      continue;
    }
    
    console.log(`[${i + 1}/${models.length}] Downloading ${model.name}...`);
    
    try {
      await downloadFile(model.url, filepath);
      console.log(`✓ Downloaded ${model.name}`);
    } catch (error) {
      console.error(`✗ Failed to download ${model.name}:`, error.message);
      process.exit(1);
    }
  }

  console.log('\n✓ All models downloaded successfully!');
  console.log(`Models saved to: ${modelsDir}`);
}

downloadModels().catch(console.error);

