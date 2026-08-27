export type CellFill = {
	letter: string;
	/** Fracción de píxeles oscuros dentro de la burbuja, entre 0 y 1. */
	fill: number;
};

export type QuestionReading = {
	question: number;
	/** Letras marcadas: vacío si la pregunta quedó en blanco, dos o más si hay doble marca. */
	answer: string;
	fills: CellFill[];
};

export type ClassifyOptions = {
	/** Relleno mínimo absoluto para considerar una burbuja marcada. */
	filledMin: number;
	/** Cuánto tiene que destacar sobre las demás alternativas de la pregunta. */
	standOut: number;
	/** Ventaja mínima de la burbuja más oscura sobre la siguiente. */
	margin: number;
};

/**
 * Umbrales sobre el contraste contra el papel, no sobre píxeles binarizados: una
 * burbuja vacía marca ~0,05 (la letra impresa adentro), una marcada a lápiz claro
 * ~0,15 y una rellena a lápiz pasta ~0,7.
 */
export const defaultClassifyOptions: ClassifyOptions = {
	filledMin: 0.12,
	standOut: 0.07,
	margin: 0.05,
};

/**
 * Decide la respuesta de una pregunta.
 *
 * El umbral no es sólo absoluto: una burbuja está marcada si además destaca sobre
 * las otras alternativas de su misma pregunta. Con un umbral fijo alto se pierden
 * las marcas de lápiz claro —aparecen como pregunta en blanco, que en una
 * corrección es el peor error— y con un umbral fijo bajo el gris del papel
 * empieza a contar como marca. La comparación dentro de la pregunta es la que
 * distingue las dos cosas, porque las cuatro o cinco burbujas comparten papel,
 * iluminación e impresión.
 *
 * Si dos quedan marcadas se devuelven ambas letras: una doble marca reportada es
 * mejor que una doble marca resuelta a dedo.
 */
export function classifyQuestion(fills: CellFill[], options: ClassifyOptions = defaultClassifyOptions): string {
	if (fills.length === 0) {
		return "";
	}

	const values = fills.map((cell) => cell.fill);
	const baseline = medianOf(values);
	const threshold = Math.max(options.filledMin, baseline + options.standOut);
	const marked = fills.filter((cell) => cell.fill >= threshold).sort((a, b) => b.fill - a.fill);
	if (marked.length === 0) {
		return "";
	}

	if (marked.length === 1) {
		const rest = values.filter((value) => value !== marked[0].fill);
		const runnerUp = rest.length === 0 ? 0 : Math.max(...rest);
		if (marked[0].fill - runnerUp < options.margin) {
			return "";
		}

		return marked[0].letter;
	}

	// Doble marca: se reportan en orden de alternativa, no de oscuridad.
	const letters = marked.map((cell) => cell.letter);
	return fills
		.filter((cell) => letters.includes(cell.letter))
		.map((cell) => cell.letter)
		.join("");
}

function medianOf(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyReadings(readings: QuestionReading[], options: ClassifyOptions = defaultClassifyOptions): string[] {
	const answers: string[] = [];
	for (const reading of readings) {
		answers[reading.question - 1] = classifyQuestion(reading.fills, options);
	}

	for (let i = 0; i < answers.length; i++) {
		answers[i] ??= "";
	}

	return answers;
}

export type VoteResult = {
	/** Respuesta ganadora por pregunta. */
	answers: string[];
	/** Votos que obtuvo la respuesta ganadora de cada pregunta. */
	votes: number[];
	/** true cuando toda la hoja alcanzó el mínimo de votos coincidentes. */
	stable: boolean;
	/** Fracción de preguntas ya estabilizadas, para la barra de progreso. */
	progress: number;
};

/**
 * Consenso entre frames: una respuesta se acepta cuando aparece igual en
 * `minVotes` lecturas. Es lo que reemplaza al "capturar y rezar" de un solo
 * frame: el ruido de un frame suelto no alcanza mayoría.
 */
export function voteAnswers(history: string[][], questions: number, minVotes: number): VoteResult {
	const answers: string[] = new Array(questions).fill("");
	const votes: number[] = new Array(questions).fill(0);

	for (let question = 0; question < questions; question++) {
		const counts = new Map<string, number>();
		for (const reading of history) {
			const value = reading[question] ?? "";
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}

		let bestValue = "";
		let bestCount = -1;
		for (const [value, count] of counts) {
			// Empate: gana la respuesta con letra, no el blanco, porque el blanco es
			// también lo que devuelve un frame borroso.
			const better = count > bestCount || (count === bestCount && value.length > bestValue.length);
			if (better) {
				bestValue = value;
				bestCount = count;
			}
		}

		answers[question] = bestValue;
		votes[question] = Math.max(bestCount, 0);
	}

	const settled = votes.filter((count) => count >= minVotes).length;

	return {
		answers,
		votes,
		stable: history.length > 0 && settled === questions,
		progress: questions === 0 ? 0 : settled / questions,
	};
}

/** Respuestas en el formato compacto que se copia o exporta: `01=A,02=,03=BC`. */
export function answersToText(answers: string[]): string {
	return answers.map((answer, index) => `${(index + 1).toString().padStart(2, "0")}=${answer}`).join(",");
}

export function answersToCsv(answers: string[]): string {
	const lines = ["pregunta,respuesta"];
	for (let i = 0; i < answers.length; i++) {
		lines.push(`${i + 1},${answers[i]}`);
	}

	return lines.join("\n");
}
