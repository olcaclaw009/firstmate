// OMP discovery entry for the shared Firstmate turn-end guard.
//
// OMP auto-discovers regular *.ts files in .omp/extensions, so this file
// delegates to the tracked Pi implementation without exposing the rest of
// .pi/extensions to OMP.
export { default } from "../../.pi/extensions/fm-primary-turnend-guard.ts";
