// Loading the app through a dynamic import keeps a failed module graph reportable: a static
// <script type="module"> that 404s leaves the page stuck on its initial "Loading model" state.
const runtimeStatus = document.getElementById('runtimeStatus');
const runtimeStatusText = document.getElementById('runtimeStatusText');
const suggestionState = document.getElementById('suggestionState');
const toastElement = document.getElementById('toast');

try {
  await import('./drawing-app.mjs');
} catch (error) {
  runtimeStatus.className = 'runtime-status error';
  runtimeStatusText.textContent = 'App failed to load';
  suggestionState.textContent = 'Unavailable';
  toastElement.textContent = `${error.message || error}. Serve the app root so index.html, src/, vendor/, models/ and data/ share one origin path.`;
  toastElement.classList.add('visible');
  throw error;
}
