const svg = (width, height, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" style="fill:${color};stroke-width:2"/></svg>`;

export function offlineInlineDataPackage(font, wav) {
  const image = `data:image/svg+xml;base64,${Buffer.from(svg(16, 16, "lime")).toString("base64")}`;
  return {
    "index.html": `<!doctype html>
      <link rel="icon" href="data:,">
      <link rel="stylesheet" href="main.css">
      <p id="sample">Sample</p>
      <img id="responsive" srcset="${image} 1x, styled.svg 2x" src="styled.svg">
      <img id="styled" src="styled.svg">
      <audio id="sound" preload="auto" src="data:audio/wav;base64,${wav.toString("base64")}"></audio>
      <div id="swatch"></div><div id="reference"></div>
      <script type="module" src="main.js"></script>`,
    "main.css": `@font-face{font-family:InlineFixture;src:url(data:font/ttf;base64,${Buffer.from(font).toString("base64")})}
      #sample{font-family:InlineFixture,sans-serif}
      #swatch,#reference{width:16px;height:16px}
      #swatch{background-image:url(${image})}
      #reference{background-color:lime}`,
    "main.js": [
      'const chunk = await import(`./chunk.js`);',
      'const image = new Image();',
      `image.src = new URL(\`${image}\`, import.meta.url).href;`,
      'await image.decode();',
      'window.moduleResult = { value: chunk.value, imageWidth: image.naturalWidth };',
    ].join("\n"),
    "chunk.js": 'export const value = "loaded";',
    "styled.svg": svg(12, 10, "red"),
  };
}
