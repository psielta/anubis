import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Excalidraw loads its canvas fonts at runtime from this base path (the study
// diagrams feature). Point it at the versioned CDN build so the fonts resolve
// without extra asset wiring; the editor still works if the CDN is unreachable
// (canvas text just falls back to a system font). To self-host instead, copy
// node_modules/@excalidraw/excalidraw/dist/prod/fonts via angular.json assets
// and set this to that served path.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH =
  'https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
