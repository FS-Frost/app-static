import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

/**
 * Genera el video que alimenta la cámara falsa de Chrome a partir de la hoja de
 * `tests/fixtures`. No se commitea: en Y4M crudo, un segundo de 1080x1440 pesa más
 * que todo el repositorio.
 */
export const FAKE_CAMERA_FILE = "test-results/camara-45.y4m";

export default function globalSetup(): void {
	if (existsSync(FAKE_CAMERA_FILE)) {
		return;
	}

	mkdirSync("test-results", { recursive: true });

	try {
		execFileSync(
			"ffmpeg",
			[
				"-y",
				"-loglevel",
				"error",
				"-loop",
				"1",
				"-i",
				"tests/fixtures/camara-45.png",
				"-frames:v",
				"2",
				"-r",
				"5",
				"-pix_fmt",
				"yuv420p",
				FAKE_CAMERA_FILE,
			],
			{ stdio: "inherit" }
		);
	} catch {
		// Sin ffmpeg el test de cámara se salta solo.
	}
}
