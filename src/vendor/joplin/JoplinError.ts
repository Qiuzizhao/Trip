// Vendored from Joplin (laurent22/joplin @ 141c451ff938e96fd0d21dab027147e59e0bf0e3, 2026-09-12)
// 原路径：packages/lib/JoplinError.ts（14 行）——未做任何改动。
// @ts-nocheck
export type JoplinErrorCode = string | number | null;

export default class JoplinError extends Error {

	public code: JoplinErrorCode = null;
	public details = '';

	public constructor(message: string, code: JoplinErrorCode = null, details: string = null) {
		super(message);
		this.code = code;
		this.details = details;
	}

}
