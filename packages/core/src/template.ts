export function renderTemplate(template: string, vars: Record<string, unknown>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = vars[key];
		return value === undefined || value === null ? match : String(value);
	});
}
