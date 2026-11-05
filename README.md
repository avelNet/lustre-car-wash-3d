# Lustre Detail Studio: scroll-driven car wash landing (demo)

Three.js + GSAP ScrollTrigger + Lenis, built with Vite.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

## How it works
- `src/scene.js`: studio, car, and a shader patch (`onBeforeCompile`) on every car material.
  The dirt is procedural (simplex fbm in world space), so any GLB works without texture prep.
  Uniforms: `uWash` (wash front, along the car's length), `uFoam` (suds), `uSwirl` (polish defects).
  The scene also has wash spray particles, a light curtain, ceramic water beads (InstancedMesh,
  ray-cast onto the body) and a warm "pick up" environment.
- `src/main.js`: one scrubbed GSAP timeline (0 to 10) drives the camera, uniforms, text and HUD.

## Before launch
- The car is three.js's free sample model (`public/models/car.glb`). Replace it with a licensed SUV
  model. The body mesh should be named `body` and the windows `glass` (or update the names in scene.js).
- Prices, copy and legal pages are placeholders. The booking form stores requests in localStorage only,
  so it needs a backend or a form service.
