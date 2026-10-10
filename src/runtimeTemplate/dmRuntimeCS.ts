import * as fs from 'fs';
import * as path from 'path';

/**
 * The engine-free C# runtime (SS13.DM.Runtime) lives as real source files in
 * <repo>/runtime/SS13.DM.Runtime so it can be compiled and tested directly;
 * this loader copies them into every generated solution.
 */
export class DMRuntimeCS {
  public static runtimeDir(): string {
    const candidates = [
      path.resolve(__dirname, '..', '..', 'runtime', 'SS13.DM.Runtime'),
      path.resolve(__dirname, '..', '..', '..', 'runtime', 'SS13.DM.Runtime'),
    ];
    const dir = candidates.find(d => fs.existsSync(d));
    if (!dir) throw new Error(`SS13.DM.Runtime sources not found (looked in ${candidates.join(', ')})`);
    return dir;
  }

  public static getRuntimeCSFiles(): { filename: string; content: string }[] {
    const dir = DMRuntimeCS.runtimeDir();
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.cs'))
      .sort()
      .map(filename => ({ filename, content: fs.readFileSync(path.join(dir, filename), 'utf-8') }));
  }
}
