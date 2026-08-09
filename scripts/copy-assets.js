const fs = require('fs');
const path = require('path');

function copy(src, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

const iconSrc = path.resolve(__dirname, '..', 'assets', 'icon.png');
const icoSrc = path.resolve(__dirname, '..', 'assets', 'icon.ico');

copy(iconSrc, path.resolve(__dirname, '..', 'dist', 'main'));
copy(iconSrc, path.resolve(__dirname, '..', 'dist', 'renderer'));
copy(icoSrc, path.resolve(__dirname, '..', 'dist', 'main'));

console.log('Assets copied.');
