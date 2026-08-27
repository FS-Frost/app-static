import { describe, expect, it } from "vitest";
import { answersToCsv, answersToText, classifyQuestion, lastTwoAgree, voteAnswers, type CellFill } from "./classify";

function fills(values: number[]): CellFill[] {
	const letters = ["A", "B", "C", "D", "E"];
	return values.map((fill, index) => ({
		letter: letters[index],
		fill,
	}));
}

describe("classifyQuestion", () => {
	it("elige la burbuja rellena", () => {
		expect(classifyQuestion(fills([0.04, 0.06, 0.72, 0.05]))).toBe("C");
	});

	it("toma una marca de lápiz claro", () => {
		expect(classifyQuestion(fills([0.05, 0.15, 0.06, 0.04]))).toBe("B");
	});

	it("no marca nada si ninguna destaca sobre las demás", () => {
		// Toda la pregunta oscura por igual: es sombra o papel gris, no una marca.
		expect(classifyQuestion(fills([0.3, 0.31, 0.29, 0.3]))).toBe("");
	});

	it("deja en blanco una pregunta sin marcar", () => {
		expect(classifyQuestion(fills([0.05, 0.08, 0.04, 0.07]))).toBe("");
	});

	it("reporta la doble marca en orden de alternativa", () => {
		expect(classifyQuestion(fills([0.05, 0.62, 0.07, 0.71]))).toBe("BD");
	});

	it("deja en blanco cuando la ventaja sobre la segunda es dudosa", () => {
		expect(classifyQuestion(fills([0.15, 0.14, 0.06, 0.05]))).toBe("");
	});

	it("no inventa respuesta sin burbujas", () => {
		expect(classifyQuestion([])).toBe("");
	});
});

describe("voteAnswers", () => {
	it("acepta la respuesta que se repite y descarta el frame raro", () => {
		const historia = [
			["A", "B", ""],
			["A", "C", ""],
			["A", "B", ""],
			["A", "B", ""],
		];

		const vote = voteAnswers(historia, 3, 3);
		expect(vote.answers).toEqual(["A", "B", ""]);
		expect(vote.votes).toEqual([4, 3, 4]);
		expect(vote.stable).toBe(true);
		expect(vote.progress).toBe(1);
	});

	it("no se estabiliza mientras falten votos", () => {
		const vote = voteAnswers([["A", "B"], ["A", "C"]], 2, 3);
		expect(vote.stable).toBe(false);
		expect(vote.progress).toBe(0);
	});

	it("en empate prefiere la letra al blanco, porque el blanco también lo da un frame borroso", () => {
		const vote = voteAnswers([["A"], [""]], 1, 1);
		expect(vote.answers).toEqual(["A"]);
	});

	it("trata como blanco las preguntas que un frame no trajo", () => {
		const vote = voteAnswers([["A"]], 2, 1);
		expect(vote.answers).toEqual(["A", ""]);
	});
});

describe("lastTwoAgree", () => {
	it("reconoce dos lecturas idénticas seguidas", () => {
		expect(lastTwoAgree([["A", ""], ["A", "B"], ["A", "B"]])).toBe(true);
	});

	it("no se conforma con una sola lectura", () => {
		expect(lastTwoAgree([["A", "B"]])).toBe(false);
	});

	it("distingue una diferencia en una sola pregunta", () => {
		expect(lastTwoAgree([["A", "B"], ["A", "C"]])).toBe(false);
	});
});

describe("exportación", () => {
	it("arma el texto compacto", () => {
		expect(answersToText(["A", "", "BC"])).toBe("01=A,02=,03=BC");
	});

	it("arma el csv con encabezado", () => {
		expect(answersToCsv(["A", ""])).toBe("pregunta,respuesta\n1,A\n2,");
	});
});
