export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly at: number;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }
}
