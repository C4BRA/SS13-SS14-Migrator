export interface Diagnostic {
  file?: string;
  line: number;
  column: number;
  message: string;
}

export class DiagnosticCollector {
  private _errors: Diagnostic[] = [];
  private _warnings: Diagnostic[] = [];
  public file: string | undefined;

  public get errors(): readonly Diagnostic[] {
    return this._errors;
  }

  public get warnings(): readonly Diagnostic[] {
    return this._warnings;
  }

  public error(message: string, line = 0, column = 0): void {
    this._errors.push({ file: this.file, line, column, message });
  }

  public warning(message: string, line = 0, column = 0): void {
    this._warnings.push({ file: this.file, line, column, message });
  }

  public merge(other: DiagnosticCollector): void {
    for (const d of other.errors) {
      this._errors.push(d.file ? d : { ...d, file: d.file ?? this.file });
    }
    for (const d of other.warnings) {
      this._warnings.push(d.file ? d : { ...d, file: d.file ?? this.file });
    }
  }

  public hasErrors(): boolean {
    return this._errors.length > 0;
  }

  public hasWarnings(): boolean {
    return this._warnings.length > 0;
  }
}
