import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera } from './canvas/Camera';
import { PanZoomInput } from './canvas/PanZoomInput';
import { Renderer } from './canvas/Renderer';
import { demoCountFromUrl, seedDemo } from './demo';
import { BoardStore } from './store/BoardStore';
import { ZoomControls } from './ui/ZoomControls';

/** 8 random characters per tab: the clientId part of shape IDs and the Lamport tie-breaker. */
const newClientId = () => crypto.randomUUID().slice(0, 8);

export function App() {
  // Created once per mount and never put in React state that changes: the canvas reads the
  // store directly, so shape edits never re-render React.
  const [store] = useState(() => {
    const s = new BoardStore(newClientId());
    seedDemo(s, demoCountFromUrl());
    return s;
  });
  const [camera] = useState(() => {
    const c = new Camera();
    // Start with a small margin so the first shapes aren't flush against the corner.
    c.x = -40;
    c.y = -40;
    return c;
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const scene = sceneRef.current;
    const overlay = overlayRef.current;
    if (!container || !scene || !overlay) return;
    const renderer = new Renderer(container, scene, overlay, store, camera);
    renderer.start();
    // Input goes on the overlay because it's the top canvas.
    const detach = new PanZoomInput(overlay, camera).attach();
    return () => {
      detach();
      renderer.stop();
    };
  }, [store, camera]);

  const getCenter = useCallback(() => {
    const el = containerRef.current;
    return { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 };
  }, []);

  return (
    <>
      <div ref={containerRef} className="board">
        <canvas ref={sceneRef} />
        <canvas ref={overlayRef} />
      </div>
      <ZoomControls camera={camera} getCenter={getCenter} />
    </>
  );
}
