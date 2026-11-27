/** A load can publish only while it is the latest read in the same account session. */
export class SessionRequests {
  private revision = 0;
  private changing = false;

  beginLoad(): (() => boolean) | null {
    if (this.changing) return null;
    const revision = ++this.revision;
    return () => this.revision === revision;
  }

  beginChange() {
    const revision = ++this.revision;
    this.changing = true;
    const current = () => this.changing && this.revision === revision;
    return {
      current,
      finish: () => {
        if (!current()) return false;
        this.changing = false;
        return true;
      },
    };
  }
}
