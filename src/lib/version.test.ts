import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "./version";

describe("parseVersion", () => {
	it("acepta la marca que escribe el workflow", () => {
		expect(parseVersion({ sha: "a1b2c3d", date: "2026-08-28T12:00:00Z" })).toEqual({
			sha: "a1b2c3d",
			date: "2026-08-28T12:00:00Z",
		});
	});

	it("tolera que falte la fecha", () => {
		expect(parseVersion({ sha: "a1b2c3d" })?.date).toBe("");
	});

	it("descarta lo que no traiga sha", () => {
		expect(parseVersion({})).toBeNull();
		expect(parseVersion({ sha: "   " })).toBeNull();
		expect(parseVersion(null)).toBeNull();
		expect(parseVersion("a1b2c3d")).toBeNull();
	});
});

describe("compareVersions", () => {
	it("avisa que hay una versión nueva si el servidor cambió", () => {
		expect(compareVersions("a1b2c3d", "a1b2c3d", "e4f5g6h")).toBe("disponible");
	});

	it("informa que ya se actualizó cuando el código corriendo es más nuevo", () => {
		expect(compareVersions("a1b2c3d", "e4f5g6h", "e4f5g6h")).toBe("actualizada");
	});

	it("no dice nada en la primera visita", () => {
		expect(compareVersions(null, "a1b2c3d", "a1b2c3d")).toBe("sin-cambios");
	});

	it("no dice nada si todo coincide", () => {
		expect(compareVersions("a1b2c3d", "a1b2c3d", "a1b2c3d")).toBe("sin-cambios");
	});

	it("no inventa avisos sin marca en el servidor", () => {
		// En desarrollo o sin red, `latest` viene vacío: no hay nada que comparar.
		expect(compareVersions("a1b2c3d", "a1b2c3d", "")).toBe("sin-cambios");
	});
});
