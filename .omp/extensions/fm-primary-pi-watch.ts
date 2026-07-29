// OMP discovery entry for the shared Firstmate watcher extension.
//
// OMP auto-discovers regular *.ts files in .omp/extensions, so this file
// delegates to the tracked Pi implementation without exposing the rest of
// .pi/extensions to OMP. Being loaded from here is also the only in-process
// signal that the host is OMP - OMP sets OMPCODE in the shells it spawns for
// tool calls, not in its own extension host - so the runtime is passed to the
// shared implementation as an argument rather than read from the environment.
import extension from "../../.pi/extensions/fm-primary-pi-watch.ts";

export default function (pi: Parameters<typeof extension>[0]) {
  return extension(pi, { runtime: "omp" });
}
