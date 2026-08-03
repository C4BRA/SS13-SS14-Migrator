"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticCollector = void 0;
class DiagnosticCollector {
    _errors = [];
    _warnings = [];
    file;
    get errors() {
        return this._errors;
    }
    get warnings() {
        return this._warnings;
    }
    error(message, line = 0, column = 0) {
        this._errors.push({ file: this.file, line, column, message });
    }
    warning(message, line = 0, column = 0) {
        this._warnings.push({ file: this.file, line, column, message });
    }
    merge(other) {
        for (const d of other.errors) {
            this._errors.push(d.file ? d : { ...d, file: d.file ?? this.file });
        }
        for (const d of other.warnings) {
            this._warnings.push(d.file ? d : { ...d, file: d.file ?? this.file });
        }
    }
    hasErrors() {
        return this._errors.length > 0;
    }
    hasWarnings() {
        return this._warnings.length > 0;
    }
}
exports.DiagnosticCollector = DiagnosticCollector;
