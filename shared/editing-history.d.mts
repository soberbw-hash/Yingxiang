import type { EditDocument, EditAction, EditingVersion } from "../src/types";
export function validateEditingHistory(value?: unknown): EditingVersion[];
export function rememberEditingVersion(history: EditingVersion[] | undefined, current: EditDocument | undefined, action: EditAction, now?: string): EditingVersion[];
