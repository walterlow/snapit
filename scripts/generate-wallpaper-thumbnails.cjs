/**
 * Generate thumbnail versions of wallpaper images for the sidebar preview.
 *
 * Usage: node scripts/generate-wallpaper-thumbnails.js
 *
 * Requires: npm install sharp
 */

const fs = require('fs');
const path = require('path');

// Check if sharp is installed
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('Error: sharp is not installed. Run: npm install sharp');
  process.exit(1);
}

const BACKGROUNDS_DIR = path.join(__dirname, '../src-tauri/assets/backgrounds');
const THUMBNAIL_SIZE = { width: 200, height: 112 }; // 16:9 aspect ratio
const THUMBNAIL_QUALITY = 60; // JPEG quality (lower = smaller file)

async function generateThumbnails() {
  const themes = fs.readdirSync(BACKGROUNDS_DIR).filter(f =>
    fs.statSync(path.join(BACKGROUNDS_DIR, f)).isDirectory()
  );

  let totalOriginal = 0;
  let totalThumbnail = 0;
  let count = 0;

  for (const theme of themes) {
    const themeDir = path.join(BACKGROUNDS_DIR, theme);
    const thumbDir = path.join(themeDir, 'thumbs');

    // Create thumbs directory if it doesn't exist
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }

    const files = fs.readdirSync(themeDir).filter(f =>
      f.endsWith('.jpg') || f.endsWith('.png')
    );

    for (const file of files) {
      const inputPath = path.join(themeDir, file);
      const outputPath = path.join(thumbDir, file.replace(/\.(jpg|png)$/, '.jpg'));

      try {
        const originalSize = fs.statSync(inputPath).size;

        await sharp(inputPath)
          .resize(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height, {
            fit: 'cover',
            position: 'center'
          })
          .jpeg({ quality: THUMBNAIL_QUALITY })
          .toFile(outputPath);

        const thumbSize = fs.statSync(outputPath).size;

        totalOriginal += originalSize;
        totalThumbnail += thumbSize;
        count++;

        console.log(`✓ ${theme}/${file}: ${(originalSize / 1024).toFixed(1)}KB → ${(thumbSize / 1024).toFixed(1)}KB`);
      } catch (err) {
        console.error(`✗ ${theme}/${file}: ${err.message}`);
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Processed: ${count} images`);
  console.log(`Original total: ${(totalOriginal / 1024 / 1024).toFixed(2)}MB`);
  console.log(`Thumbnail total: ${(totalThumbnail / 1024 / 1024).toFixed(2)}MB`);
  console.log(`Reduction: ${((1 - totalThumbnail / totalOriginal) * 100).toFixed(1)}%`);
}

generateThumbnails().catch(console.error);
