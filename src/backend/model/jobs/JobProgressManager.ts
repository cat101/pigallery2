import {promises as fsp} from 'fs';
import * as path from 'path';
import {ProjectPath} from '../../ProjectPath';
import {Config} from '../../../common/config/private/Config';
import {JobProgressDTO, JobProgressStates,} from '../../../common/entities/job/JobProgressDTO';
import {NotificationManager} from '../NotifocationManager';

export class JobProgressManager {
  private static readonly VERSION = 3;
  private db: {
    version: number;
    progresses: {
      [key: string]: { progress: JobProgressDTO; timestamp: number };
    };
  } = {
    version: JobProgressManager.VERSION,
    progresses: {},
  };
  private readonly dbPath: string;
  private timer: NodeJS.Timeout = null;

  constructor() {
    this.dbPath = path.join(ProjectPath.DBFolder, 'jobs.db');
    this.loadDB().catch(console.error);
  }

  get Progresses(): { [key: string]: JobProgressDTO } {
    const m: { [key: string]: JobProgressDTO } = {};
    for (const key of Object.keys(this.db.progresses)) {
      m[key] = this.db.progresses[key].progress;
      if (
          this.db.progresses[key].progress.state === JobProgressStates.running
      ) {
        m[key].time.end = Date.now();
      }
    }
    return m;
  }

  onJobProgressUpdate(progress: JobProgressDTO): void {
    this.db.progresses[progress.HashName] = {progress, timestamp: Date.now()};
    this.delayedSave();
  }

  private async loadDB(): Promise<void> {
    try {
      await fsp.access(this.dbPath);
    } catch (e) {
      return;
    }
    const data = await fsp.readFile(this.dbPath, 'utf8');
    const db = JSON.parse(data);
    if (db.version !== JobProgressManager.VERSION) {
      return;
    }
    this.db = db;

    while (
        Object.keys(this.db.progresses).length >
        Config.Jobs.maxSavedProgress
        ) {
      let min: string = null;
      for (const key of Object.keys(this.db.progresses)) {
        if (
            min === null ||
            this.db.progresses[min].timestamp > this.db.progresses[key].timestamp
        ) {
          min = key;
        }
      }
      delete this.db.progresses[min];
    }

    for (const key of Object.keys(this.db.progresses)) {
      if (
          this.db.progresses[key].progress.state === JobProgressStates.running ||
          this.db.progresses[key].progress.state === JobProgressStates.cancelling
      ) {
        this.db.progresses[key].progress.state = JobProgressStates.interrupted;
        // A job that was still running at the last shutdown was killed mid-flight
        // (server restart, container OOM, crash) — its results are likely
        // incomplete even though nothing logged a failure. A hard crash can't
        // report itself, so this startup reconciliation is the only place to
        // surface it: raise an admin notification prompting a re-run.
        NotificationManager.warning(
          'Job interrupted: ' + this.db.progresses[key].progress.jobName,
          'The job was still running when the server last stopped (restart or crash) ' +
          'and may be incomplete. Consider re-running it.'
        );
      }
    }
  }

  private async saveDB(): Promise<void> {
    await fsp.writeFile(this.dbPath, JSON.stringify(this.db));
  }

  private delayedSave(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(async (): Promise<void> => {
      this.saveDB().catch(console.error);
      this.timer = null;
    }, 5000);
  }
}
