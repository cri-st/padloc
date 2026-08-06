import { Dialog } from "../elements/dialog";
import { app, router } from "../globals";

type Constructor<T> = new (...args: any[]) => T;

export function AutoLock<B extends Constructor<Object>>(baseClass: B) {
    return class extends baseClass {
        _pausedAt: Date | null = null;
        _hiddenAt: Date | null = null;
        _lockTimeout?: number;

        get _lockDelay() {
            return app.settings.autoLockDelay * 60 * 1000;
        }

        constructor(...args: any[]) {
            super(...args);
            document.addEventListener("click", () => this._startTimer());
            document.addEventListener("keydown", () => this._startTimer());
            document.addEventListener("pause", () => this._pause());
            document.addEventListener("resume", () => this._resume());
            // SECURITY: a background/hidden browser tab can have its
            // setTimeout throttled or fully suspended, so the timer
            // started in _startTimer() below isn't guaranteed to actually
            // fire while the tab is hidden -- the vault could stay
            // unlocked far longer than autoLockDelay if the user left the
            // tab open and backgrounded. Record when the page was hidden
            // and explicitly re-check elapsed time when it becomes
            // visible again, mirroring the existing cordova pause/resume
            // handling above.
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "hidden") {
                    this._hiddenAt = new Date();
                } else {
                    this._checkElapsedSinceHidden();
                }
            });
            // A page restored from the back-forward cache resumes with
            // its old JS state (including an unlocked vault in memory)
            // without re-running any of this constructor's setup timers
            // -- explicitly re-validate elapsed time in that case too.
            window.addEventListener("pageshow", (e: PageTransitionEvent) => {
                if (e.persisted) {
                    this._checkElapsedSinceHidden();
                }
            });
        }

        private _checkElapsedSinceHidden() {
            if (
                app.settings.autoLock &&
                !app.state.locked &&
                this._hiddenAt &&
                new Date().getTime() - this._hiddenAt.getTime() > this._lockDelay
            ) {
                this._doLock();
            }
            this._hiddenAt = null;
            this._startTimer();
        }

        _cancelAutoLock() {
            this._pausedAt = null;
            if (this._lockTimeout) {
                clearTimeout(this._lockTimeout);
            }
            // if (this._lockNotificationTimeout) {
            //     clearTimeout(this._lockNotificationTimeout);
            // }
        }

        // Handler for cordova `pause` event. Records the current time for auto locking when resuming
        _pause() {
            this._pausedAt = new Date();
        }

        // Handler for cordova `resume` event. If auto lock is enabled and the specified time has passed
        // since the app was paused, locks the app
        _resume() {
            if (
                app.settings.autoLock &&
                !app.state.locked &&
                this._pausedAt &&
                new Date().getTime() - this._pausedAt.getTime() > this._lockDelay
            ) {
                this._doLock();
            }
            this._startTimer();
        }

        private async _doLock() {
            // if app is currently syncing restart the timer
            if (app.state.syncing) {
                this._startTimer();
                return;
            }

            Dialog.closeAll();
            await app.lock();
            router.go("unlock");
        }

        private _startTimer() {
            this._cancelAutoLock();
            if (app.settings.autoLock && !app.state.locked && this._lockDelay > 0) {
                this._lockTimeout = window.setTimeout(() => this._doLock(), this._lockDelay);
                // this._lockNotificationTimeout = setTimeout(() => {
                //     if (!this.locked && !this._pausedAt) {
                //         this.notify($l("Auto-lock in 10 seconds"), "info", 3000);
                //     }
                // }, this._lockDelay - 10000);
            }
        }
    };
}
