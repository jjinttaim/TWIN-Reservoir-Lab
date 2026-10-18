# Third-party components

- SheetJS Community Edition 0.20.3, Apache License 2.0. Vendored as assets/xlsx.full.min.js for offline XLS/XLSX reading. Official distribution: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js . Documentation: https://docs.sheetjs.com/docs/getting-started/installation/standalone/ .
- Three.js 0.186.1, MIT License, including OrbitControls, GLTFLoader, Reflector, and RoomEnvironment. Bundled locally into assets/app.js for 3D rendering. License: assets/Three-LICENSE.txt. Project: https://threejs.org/ .
- uPlot 1.6.32, MIT License. Bundled locally into assets/app.js (its stylesheet is inlined at the top of assets/style.css) for the time series charts. License: assets/uPlot-LICENSE.txt. Project: https://github.com/leeoniya/uPlot .
- esbuild 0.28.2, MIT License, development build dependency only. https://esbuild.github.io/ . The built program does not contact esbuild or a CDN.
- The AI forecaster weights in assets/ai/model.json were trained with PyTorch (BSD-3-Clause) offline; PyTorch itself is not part of the program. Inference runs in src/ai-forecast.mjs without external libraries.

No remote fonts, analytics, telemetry, or remote runtime dependencies are used by the app.
