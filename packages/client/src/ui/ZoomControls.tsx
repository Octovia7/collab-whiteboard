import { useCallback, useSyncExternalStore } from 'react';
import type { Camera } from '../canvas/Camera';
import { MinusIcon, PlusIcon } from './icons';

const STEP = 1.25;

interface Props {
  camera: Camera;
  /** Screen point (CSS px) to zoom around for the buttons: the middle of the board. */
  getCenter: () => { x: number; y: number };
}

export function ZoomControls({ camera, getCenter }: Props) {
  // Subscribes to camera changes but re-renders only when the zoom number changes:
  // pans fire the same event, and useSyncExternalStore bails out on an equal snapshot.
  const subscribe = useCallback((notify: () => void) => camera.events.on('change', notify), [camera]);
  const zoom = useSyncExternalStore(subscribe, () => camera.zoom);

  const zoomBy = (factor: number) => {
    const c = getCenter();
    camera.zoomAt(c.x, c.y, factor);
  };
  const reset = () => {
    const c = getCenter();
    camera.setZoomAt(c.x, c.y, 1);
  };

  return (
    <div className="zoom-controls panel">
      <button type="button" className="icon-button" onClick={() => zoomBy(1 / STEP)} aria-label="Zoom out" title="Zoom out">
        <MinusIcon />
      </button>
      <button type="button" className="zoom-level" onClick={reset} title="Reset to 100%">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="icon-button" onClick={() => zoomBy(STEP)} aria-label="Zoom in" title="Zoom in">
        <PlusIcon />
      </button>
    </div>
  );
}
