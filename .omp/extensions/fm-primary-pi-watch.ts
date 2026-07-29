// OMP discovery entry for the shared Firstmate watcher extension.
//
// OMP auto-discovers regular *.ts files in .omp/extensions, so this file
// delegates to the tracked Pi implementation without exposing the rest of
// .pi/extensions to OMP.
export { default } from "../../.pi/extensions/fm-primary-pi-watch.ts";
