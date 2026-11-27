import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
interface PetConfig {
  /** Composition-level master switch; when false the plugin loads but shows nothing. */
  enabled: boolean;
  /** Keep the pet above other windows. */
  alwaysOnTop: boolean;
  /** Integer scale multiplier applied to the 192×208 atlas cells. */
  petScale: number;
  /** Which pet to display (a directory name under `assets/pets/`). */
  petId: string;
  /** Hide the pet while no task is running; show it again on activity. */
  hideWhenIdle: boolean;
  /** Run the frame animation. When false, a single static frame is shown. */
  animationEnabled: boolean;
  /** Seconds (>=8) between randomized idle variations. */
  idleFrequencySec: number;
  /** Pass pointer events through the window (Windows only). */
  clickThrough: boolean;
  /** Start in the sleeping state. */
  startSleeping: boolean;
  /** Global animation speed multiplier. */
  animationSpeed: number;
}
declare const Config: z<PetConfig>;
//#endregion
//#region src/index.d.ts
declare const name = "desktop-pet";
declare const inject: string[];
declare function apply(ctx: Context, config: PetConfig): void;
//#endregion
export { Config, type PetConfig, apply, inject, name };