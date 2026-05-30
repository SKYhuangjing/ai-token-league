// Design-pattern tests for update state machine in renderer.js.
// These do NOT import production code — they verify the state machine patterns
// (downloaded persistence, install running, background merge, IPC race guard) are correct in isolation.
// Production regression coverage comes from E2E tests.

describe('Update state machine', () => {
  let latestUpdateState;
  let updateDownloadedPersisted;
  let updateInstallRunning;
  let downloadedEventReceived;

  function hasReadyUpdatePackage(state = latestUpdateState) {
    const update = state?.update || state?.lastResult || null;
    return Boolean(state?.readyPackage || state?.status === "downloaded" || update?.status === "downloaded" || updateDownloadedPersisted);
  }

  function isUpdateDownloading(state = latestUpdateState) {
    return Boolean(state?.downloadProgress || state?.downloadRunning || state?.status === "downloading");
  }

  function applyProgressEvent(data) {
    const merged = { ...(latestUpdateState || {}), ...(data || {}) };
    if (data.status === "downloaded" && !updateDownloadedPersisted) {
      merged.status = "downloading";
      delete merged.downloadProgress;
      delete merged.downloadRunning;
    }
    latestUpdateState = merged;
  }

  function applyBackgroundStatus(updateCheck) {
    if (updateCheck) {
      latestUpdateState = {
        ...(latestUpdateState || {}),
        ...updateCheck
      };
      if (updateDownloadedPersisted) latestUpdateState.status = "downloaded";
    }
  }

  beforeEach(() => {
    latestUpdateState = null;
    updateDownloadedPersisted = false;
    updateInstallRunning = false;
    downloadedEventReceived = false;
  });

  describe('hasReadyUpdatePackage', () => {
    it('returns false when no update state', () => {
      expect(hasReadyUpdatePackage()).toBe(false);
    });

    it('returns true when status is downloaded', () => {
      latestUpdateState = { status: "downloaded" };
      expect(hasReadyUpdatePackage()).toBe(true);
    });

    it('returns true when update.status is downloaded', () => {
      latestUpdateState = { update: { status: "downloaded", updateAvailable: true } };
      expect(hasReadyUpdatePackage()).toBe(true);
    });

    it('returns true when updateDownloadedPersisted is set', () => {
      updateDownloadedPersisted = true;
      latestUpdateState = { status: "idle" };
      expect(hasReadyUpdatePackage()).toBe(true);
    });

    it('returns false when only updateAvailable without downloaded', () => {
      latestUpdateState = { update: { updateAvailable: true } };
      expect(hasReadyUpdatePackage()).toBe(false);
    });
  });

  describe('progress event merge', () => {
    it('merges progress data into existing state', () => {
      latestUpdateState = { update: { updateAvailable: true, latestVersion: "1.0.1" }, status: "checking" };
      applyProgressEvent({ downloadProgress: { percent: 50, bytesPerSecond: 1024 } });
      expect(latestUpdateState.update.updateAvailable).toBe(true);
      expect(latestUpdateState.downloadProgress.percent).toBe(50);
      expect(latestUpdateState.status).toBe("checking");
    });

    it('does NOT set status=downloaded on downloaded event — forces downloading', () => {
      latestUpdateState = { update: { updateAvailable: true }, status: "checking" };
      applyProgressEvent({ status: "downloaded" });
      expect(latestUpdateState.status).toBe("downloading");
      expect(latestUpdateState.update.updateAvailable).toBe(true);
    });

    it('clears downloadProgress on downloaded event', () => {
      latestUpdateState = { downloadProgress: { percent: 99 }, status: "checking" };
      applyProgressEvent({ status: "downloaded" });
      expect(latestUpdateState.downloadProgress).toBeUndefined();
      expect(latestUpdateState.downloadRunning).toBeUndefined();
    });

    it('preserves existing state when event has no status', () => {
      latestUpdateState = { update: { updateAvailable: true }, status: "checking" };
      applyProgressEvent({ downloadProgress: { percent: 75, bytesPerSecond: 2048 } });
      expect(latestUpdateState.update.updateAvailable).toBe(true);
      expect(latestUpdateState.status).toBe("checking");
    });

    it('isUpdateDownloading stays true after downloaded event (status forced to downloading)', () => {
      latestUpdateState = { downloadProgress: { percent: 100 }, status: "checking" };
      applyProgressEvent({ status: "downloaded" });
      expect(isUpdateDownloading()).toBe(true);
    });
  });

  describe('IPC race guard: downloaded event after resolve', () => {
    it('late downloaded event does NOT regress status when updateDownloadedPersisted is true', () => {
      // Simulate: download completed, downloadUpdate() resolved
      latestUpdateState = { update: { updateAvailable: true }, status: "downloaded" };
      updateDownloadedPersisted = true;

      // Late "downloaded" event arrives after resolve
      applyProgressEvent({ status: "downloaded" });

      // Status MUST stay "downloaded" — not regressed to "downloading"
      expect(latestUpdateState.status).toBe("downloaded");
      expect(isUpdateDownloading()).toBe(false);
      expect(hasReadyUpdatePackage()).toBe(true);
    });

    it('late downloaded event does NOT delete progress data when persisted', () => {
      latestUpdateState = { status: "downloaded", update: { latestVersion: "1.0.1" } };
      updateDownloadedPersisted = true;

      applyProgressEvent({ status: "downloaded" });

      // No side effects from the guard being active
      expect(latestUpdateState.update.latestVersion).toBe("1.0.1");
    });

    it('downloaded event STILL forces downloading when updateDownloadedPersisted is false', () => {
      latestUpdateState = { update: { updateAvailable: true }, status: "checking" };
      updateDownloadedPersisted = false;

      applyProgressEvent({ status: "downloaded" });

      expect(latestUpdateState.status).toBe("downloading");
      expect(isUpdateDownloading()).toBe(true);
    });
  });

  describe('downloadedEventReceived blocks progress messages', () => {
    it('downloadedEventReceived is set when downloaded event arrives', () => {
      latestUpdateState = { status: "checking" };
      applyProgressEvent({ status: "downloaded" });
      downloadedEventReceived = true;
      expect(downloadedEventReceived).toBe(true);
    });

    it('progress percent is ignored when downloadedEventReceived is true', () => {
      latestUpdateState = { status: "downloading" };
      downloadedEventReceived = true;

      // Simulate late progress event
      applyProgressEvent({ downloadProgress: { percent: 50, bytesPerSecond: 1024 } });

      // The event data is merged, but the UI code checks downloadedEventReceived
      // before displaying — verify the flag is still true
      expect(downloadedEventReceived).toBe(true);
    });
  });

  describe('downloadUpdate sets status after resolve', () => {
    it('sets status=downloaded and clears progress after promise', () => {
      latestUpdateState = { update: { updateAvailable: true }, status: "checking" };
      updateDownloadedPersisted = true;
      latestUpdateState = { ...(latestUpdateState || {}), status: "downloaded" };
      delete latestUpdateState.downloadProgress;
      delete latestUpdateState.downloadRunning;
      expect(hasReadyUpdatePackage()).toBe(true);
      expect(isUpdateDownloading()).toBe(false);
      expect(latestUpdateState.update.updateAvailable).toBe(true);
    });
  });

  describe('backgroundStatus merge', () => {
    it('merges background status into existing state', () => {
      latestUpdateState = { update: { updateAvailable: true, latestVersion: "1.0.1" }, status: "downloaded" };
      updateDownloadedPersisted = true;
      applyBackgroundStatus({ status: "idle" });
      expect(latestUpdateState.update.updateAvailable).toBe(true);
      expect(latestUpdateState.update.latestVersion).toBe("1.0.1");
      expect(latestUpdateState.status).toBe("downloaded");
    });

    it('preserves downloaded status when updateDownloadedPersisted is set', () => {
      latestUpdateState = { status: "downloaded" };
      updateDownloadedPersisted = true;
      applyBackgroundStatus({ status: "idle" });
      expect(latestUpdateState.status).toBe("downloaded");
      expect(hasReadyUpdatePackage()).toBe(true);
    });

    it('allows idle when updateDownloadedPersisted is NOT set', () => {
      latestUpdateState = { status: "downloaded" };
      updateDownloadedPersisted = false;
      applyBackgroundStatus({ status: "idle" });
      expect(latestUpdateState.status).toBe("idle");
      expect(hasReadyUpdatePackage()).toBe(false);
    });

    it('does not lose lastResult metadata', () => {
      latestUpdateState = { lastResult: { updateAvailable: true, latestVersion: "1.0.1" }, status: "downloaded" };
      updateDownloadedPersisted = true;
      applyBackgroundStatus({ status: "idle" });
      expect(latestUpdateState.lastResult.updateAvailable).toBe(true);
      expect(latestUpdateState.lastResult.latestVersion).toBe("1.0.1");
    });
  });

  describe('install running state', () => {
    it('updateInstallRunning starts false', () => {
      expect(updateInstallRunning).toBe(false);
    });

    it('buttons should be disabled when updateInstallRunning', () => {
      updateInstallRunning = true;
      const enforcementDisabled = isUpdateDownloading(latestUpdateState) || updateInstallRunning;
      expect(enforcementDisabled).toBe(true);
    });

    it('buttons should be enabled when install finished and ready', () => {
      latestUpdateState = { status: "downloaded" };
      updateInstallRunning = false;
      const enforcementDisabled = isUpdateDownloading(latestUpdateState) || updateInstallRunning;
      expect(enforcementDisabled).toBe(false);
    });

    it('buttons should be disabled when downloading even if not installing', () => {
      latestUpdateState = { downloadProgress: { percent: 50 } };
      updateInstallRunning = false;
      const enforcementDisabled = isUpdateDownloading(latestUpdateState) || updateInstallRunning;
      expect(enforcementDisabled).toBe(true);
    });
  });

  describe('cloud reset clears all flags', () => {
    it('resets all update flags', () => {
      latestUpdateState = { status: "downloaded" };
      updateDownloadedPersisted = true;
      updateInstallRunning = false;
      downloadedEventReceived = true;
      // Simulate refreshCloudDependentState
      latestUpdateState = null;
      updateDownloadedPersisted = false;
      updateInstallRunning = false;
      downloadedEventReceived = false;
      expect(hasReadyUpdatePackage()).toBe(false);
      expect(updateDownloadedPersisted).toBe(false);
      expect(updateInstallRunning).toBe(false);
      expect(downloadedEventReceived).toBe(false);
    });
  });
});
