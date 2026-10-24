import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "logic.js" as Logic

ShellRoot {
    id: root

    // The same directory the `familiar` CLI it drives uses: FAMILIAR_STATE_DIR when it is
    // an absolute path, otherwise the default.
    readonly property string stateDir: {
        const override = Quickshell.env("FAMILIAR_STATE_DIR") || "";
        return override.startsWith("/") ? override : Quickshell.env("HOME") + "/.local/state/familiar";
    }
    // One consumer identity per shell start; its reservations are its own.
    readonly property string consumerId: "popup-" + Date.now() + "-" + Math.floor(Math.random() * 1e9)
    property string attentionText: ""
    property string healthText: ""
    property string bootId: ""
    // undefined until this consumer has attached, then null (idle) or the playing job.
    property var activeJob: undefined
    property bool attaching: false
    // After a failed request or an empty claim, nothing is claimed or attached again
    // until the backoff ends: a broken CLI must not become a loop of processes.
    property bool claimHeld: false
    property var requests: []
    property var currentRequest: null
    property var queryCandidate: null
    property var pendingCandidate: null
    property var activeCandidate: null
    property ShellScreen targetScreen: null
    property bool overlayMapped: false
    property bool playbackStarted: false
    property string phase: ""
    // The first motion of a moment, held until the freshly mapped overlay has
    // presented a frame. Mapping the layer surface and uploading the sprite
    // texture land in that frame; starting the clock before it spends the
    // opening of a 250 ms entry on frames that never reach the screen.
    property var pendingLaunch: null

    // Every change of attention, health or time is one decision from the shared
    // logic: attach, claim, cancel, preempt or nothing. No lifecycle is inferred here.
    function evaluate() {
        const parsed = Logic.parseAttention(attentionText);
        if (parsed.error !== null) {
            if (attentionText !== "") console.warn("[familiar-desktop] " + parsed.error);
            return;
        }
        const live = { now: Date.now(), bootId: bootId.trim(), desktopSession: Quickshell.env("NIRI_SOCKET") || "" };
        const view = Logic.viewOf(parsed.snapshot, healthText, live);
        const decision = Logic.nextMoment(view, activeJob);
        if (decision.action === "initialise") attach(view);
        else if (decision.action === "claim") claim();
        else if (decision.action === "cancel" || decision.action === "preempt") {
            interrupt();
            Qt.callLater(evaluate);
        }
    }

    function attach(view) {
        if (attaching || claimHeld) return;
        const batches = Logic.initialBatches(view);
        if (batches.length === 0) {
            activeJob = null;
            Qt.callLater(evaluate);
            return;
        }
        attaching = true;
        for (let i = 0; i < batches.length; i++) {
            send({ op: "initialise", consumerId: consumerId, ids: batches[i] }, { last: i === batches.length - 1 });
        }
    }

    function claim() {
        if (claimHeld || currentRequest !== null || requests.length > 0) return;
        send({ op: "claim", consumerId: consumerId }, {});
    }

    function finish(job, outcome) {
        send({ op: "finish", consumerId: consumerId, token: job.token, outcome: outcome }, {});
    }

    // Stops the moment on screen and gives up its reservation; the episode itself, and
    // every other queued one, stays in the shared state.
    function interrupt() {
        const job = activeJob;
        stopVisual();
        activeJob = null;
        if (job) finish(job, "interrupted");
    }

    // Control requests run one at a time: stdin carries one request and is then
    // closed so the CLI sees EOF; the next request waits for this one's exit.
    function send(request, context) {
        requests = requests.concat([{ request: request, context: context }]);
        if (currentRequest === null) Qt.callLater(startNextRequest);
    }

    function startNextRequest() {
        if (currentRequest !== null || requests.length === 0) return;
        currentRequest = requests[0];
        requests = requests.slice(1);
        control.stdinEnabled = true;
        control.running = true;
        controlTimeout.restart();
    }

    function controlStarted() {
        control.write(Logic.encodeRequest(currentRequest.request));
        control.stdinEnabled = false;
    }

    function controlExited(exitCode) {
        controlTimeout.stop();
        const finished = currentRequest;
        currentRequest = null;
        if (finished !== null) {
            const parsed = exitCode === 0 ? Logic.parseReply(String(controlStdout.text || ""), finished.request.op)
                : { reply: null, error: finished.request.op + " exited " + exitCode + ": " + String(controlStderr.text || "").trim() };
            handleReply(finished, parsed);
        }
        Qt.callLater(startNextRequest);
    }

    function holdClaims() {
        claimHeld = true;
        claimBackoff.restart();
    }

    // A request whose process never started (or never exited) within the timeout is
    // released as a failure, so the queue moves on instead of wedging.
    function controlTimedOut() {
        if (control.running) {
            control.running = false;
            return;
        }
        if (currentRequest === null) return;
        const stuck = currentRequest;
        currentRequest = null;
        handleReply(stuck, { reply: null, error: stuck.request.op + " did not start" });
        Qt.callLater(startNextRequest);
    }

    function handleReply(finished, parsed) {
        const op = finished.request.op;
        if (parsed.error !== null) console.warn("[familiar-desktop] " + parsed.error);
        if (op === "initialise") {
            // Attached only once every batch succeeded; a failure retries after the backoff.
            if (parsed.error !== null) {
                attaching = false;
                holdClaims();
            }
            else if (finished.context.last) {
                attaching = false;
                activeJob = null;
            }
        } else if (op === "claim") {
            if (parsed.error !== null || parsed.reply.job === null) holdClaims();
            if (parsed.error === null && parsed.reply.job !== null) {
                // A reservation this consumer cannot play right now is handed back.
                if (activeJob === null) startJob(parsed.reply);
                else finish({ token: parsed.reply.token }, "interrupted");
            }
        } else if (op === "finish" && parsed.error === null) {
            activeJob = Logic.jobAfterFinish(activeJob, finished.request.token);
        }
        Qt.callLater(evaluate);
    }

    function startJob(reply) {
        const job = reply.job;
        job.token = reply.token;
        activeJob = job;
        const playback = Logic.playbackFor(job);
        if (playback.error !== null) {
            failMoment(playback.error);
            return;
        }
        if (!playback.draw) {
            // motion off: no popup is drawn; the pill and the toast still carry it.
            activeJob = null;
            finish(job, "suppressed");
            return;
        }
        watchdog.restart();
        const candidate = { sprite: playback.sprite, motionPolicy: playback.mode, state: playback.choreography };
        if (focusQuery.running) {
            pendingCandidate = candidate;
            return;
        }
        queryCandidate = candidate;
        focusQuery.running = true;
    }

    function screenNamed(name) {
        for (let i = 0; i < Quickshell.screens.length; i++) {
            if (Quickshell.screens[i].name === name) return Quickshell.screens[i];
        }
        return null;
    }

    function queryFinished(exitCode) {
        if (pendingCandidate !== null) {
            const candidate = pendingCandidate;
            queryCandidate = candidate;
            pendingCandidate = null;
            Qt.callLater(function() {
                if (queryCandidate === candidate && activeJob) {
                    focusQuery.running = true;
                }
            });
            return;
        }
        if (queryCandidate === null) return;

        const candidate = queryCandidate;
        queryCandidate = null;
        if (exitCode !== 0) {
            const detail = String(focusStderr.text || "").trim();
            failMoment("focused-output exited " + exitCode + (detail === "" ? "" : ": " + detail));
            return;
        }

        const parsed = Logic.parseFocusedOutput(focusStdout.text);
        if (parsed.error !== null) {
            failMoment(parsed.error);
            return;
        }
        const screen = screenNamed(parsed.name);
        if (screen === null) {
            failMoment('focused-output: no Quickshell screen named "' + parsed.name + '"');
            return;
        }

        activeCandidate = candidate;
        targetScreen = screen;
        playbackStarted = false;
        overlayMapped = true;
        Qt.callLater(startWhenReady);
    }

    function largeHeight() {
        return Math.min(overlay.height * 0.90, overlay.width * 0.55);
    }

    function centerX() {
        return (overlay.width - familiarImage.width) / 2;
    }

    function peekY() {
        return overlay.height - familiarImage.height * 0.70;
    }

    function stopMotion() {
        pendingLaunch = null;
        yAnimation.stop();
        opacityAnimation.stop();
        hold.stop();
        phase = "";
    }

    function unmapVisual() {
        stopMotion();
        overlayMapped = false;
        playbackStarted = false;
        activeCandidate = null;
        targetScreen = null;
    }

    function stopVisual() {
        watchdog.stop();
        queryCandidate = null;
        pendingCandidate = null;
        if (focusQuery.running) focusQuery.running = false;
        unmapVisual();
    }

    // The moment ran to its end: it was shown.
    function finishPlayback() {
        const job = activeJob;
        stopVisual();
        activeJob = null;
        if (job) finish(job, "delivered");
    }

    // Missing art, no focused output or a stalled render: a failed popup. The episode
    // stays pending for the pill and the toast; nothing about the request is closed.
    function failMoment(message) {
        console.warn("[familiar-desktop] " + message);
        const job = activeJob;
        stopVisual();
        activeJob = null;
        if (job) finish(job, "failed");
    }

    function startWhenReady() {
        if (!overlayMapped || playbackStarted || activeCandidate === null
            || overlay.width <= 0 || overlay.height <= 0) return;
        if (familiarImage.status === Image.Error) {
            failMoment('sprite failed to load: "' + activeCandidate.sprite + '"');
            return;
        }
        if (familiarImage.status !== Image.Ready) return;
        playbackStarted = true;
        if (activeCandidate.motionPolicy === "full") startFull();
        else if (activeCandidate.motionPolicy === "reduced") startReduced();
        else failMoment('unexpected motion policy: "' + activeCandidate.motionPolicy + '"');
    }

    function animateY(to, duration, easingType, nextPhase) {
        phase = nextPhase;
        yAnimation.to = to;
        yAnimation.duration = duration;
        yAnimation.easing.type = easingType;
        yAnimation.start();
    }

    function animateOpacity(to, duration, nextPhase) {
        phase = nextPhase;
        opacityAnimation.to = to;
        opacityAnimation.duration = duration;
        opacityAnimation.start();
    }

    function waitFor(duration, nextPhase) {
        phase = nextPhase;
        hold.interval = duration;
        hold.start();
    }

    function configureSmall(opacity) {
        familiarImage.height = largeHeight() / 2;
        familiarImage.x = centerX();
        familiarImage.y = overlay.height;
        familiarImage.rotation = 0;
        familiarImage.opacity = opacity;
    }

    function configureLarge(opacity) {
        familiarImage.height = largeHeight();
        familiarImage.x = centerX();
        familiarImage.y = -familiarImage.height;
        familiarImage.rotation = 0;
        familiarImage.opacity = opacity;
    }

    function launchAfterFrame(launch) {
        phase = "awaiting-frame";
        pendingLaunch = launch;
    }

    function frameSwapped() {
        if (pendingLaunch === null) return;
        const launch = pendingLaunch;
        pendingLaunch = null;
        launch();
    }

    function startFull() {
        if (activeCandidate.state === "done" || activeCandidate.state === "peek") {
            configureSmall(1);
            const peek = peekY();
            launchAfterFrame(function() { animateY(peek, 250, Easing.OutCubic, "done-entered"); });
        } else {
            configureLarge(1);
            familiarImage.rotation = 8;
            const floor = overlay.height;
            launchAfterFrame(function() { animateY(floor, 1100, Easing.InQuad, "error-fallen"); });
        }
    }

    function startReduced() {
        if (activeCandidate.state === "done" || activeCandidate.state === "peek") {
            configureSmall(0);
            familiarImage.y = peekY();
            launchAfterFrame(function() { animateOpacity(1, 200, "done-faded-in"); });
        } else {
            configureLarge(0);
            familiarImage.y = (overlay.height - familiarImage.height) / 2;
            launchAfterFrame(function() { animateOpacity(1, 200, "error-faded-in"); });
        }
    }

    function animationFinished() {
        if (phase === "done-entered") waitFor(700, "done-held");
        else if (phase === "done-left") finishPlayback();
        else if (phase === "error-fallen") waitFor(180, "error-beat");
        else if (phase === "error-peeked") waitFor(450, "error-peek-held");
        else if (phase === "error-left") finishPlayback();
        else if (phase === "done-faded-in") waitFor(700, "done-fade-held");
        else if (phase === "done-faded-out") finishPlayback();
        else if (phase === "error-faded-in") waitFor(700, "error-fade-held");
        else if (phase === "error-large-faded-out") {
            configureSmall(0);
            familiarImage.y = peekY();
            animateOpacity(1, 200, "error-small-faded-in");
        } else if (phase === "error-small-faded-in") waitFor(450, "error-small-held");
        else if (phase === "error-small-faded-out") finishPlayback();
    }

    function holdFinished() {
        if (phase === "done-held") animateY(overlay.height, 250, Easing.InCubic, "done-left");
        else if (phase === "error-beat") {
            configureSmall(1);
            animateY(peekY(), 250, Easing.OutCubic, "error-peeked");
        } else if (phase === "error-peek-held") {
            animateY(overlay.height, 250, Easing.InCubic, "error-left");
        } else if (phase === "done-fade-held") {
            animateOpacity(0, 200, "done-faded-out");
        } else if (phase === "error-fade-held") {
            animateOpacity(0, 200, "error-large-faded-out");
        } else if (phase === "error-small-held") {
            animateOpacity(0, 200, "error-small-faded-out");
        }
    }

    FileView {
        id: attentionView
        path: root.stateDir + "/attention.json"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: {
            root.attentionText = text();
            root.evaluate();
        }
        onLoadFailed: retry.start()
    }

    FileView {
        id: healthView
        path: root.stateDir + "/attention-health.json"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.healthText = text()
        onLoadFailed: root.healthText = ""
    }

    // This boot, read live: a heartbeat saved before a reboot must not look healthy.
    FileView {
        id: bootView
        path: "/proc/sys/kernel/random/boot_id"
        blockLoading: true
        printErrors: false
        onLoaded: root.bootId = text()
    }

    Timer {
        id: retry
        interval: 3000
        repeat: true
        onTriggered: {
            attentionView.reload();
            if (root.attentionText !== "") stop();
        }
    }

    // Health ages without any file changing; re-judge it on the heartbeat's cadence.
    Timer {
        interval: 2000
        repeat: true
        running: true
        onTriggered: root.evaluate()
    }

    Process {
        id: control
        command: ["familiar", "attention", "popup"]
        running: false
        stdout: StdioCollector { id: controlStdout; waitForEnd: true }
        stderr: StdioCollector { id: controlStderr; waitForEnd: true }
        onStarted: root.controlStarted()
        onExited: function(exitCode, exitStatus) { root.controlExited(exitCode); }
    }

    Timer {
        id: controlTimeout
        interval: 2000
        repeat: false
        onTriggered: root.controlTimedOut()
    }

    Timer {
        id: claimBackoff
        interval: 2000
        repeat: false
        onTriggered: {
            root.claimHeld = false;
            root.evaluate();
        }
    }

    Process {
        id: focusQuery
        command: ["niri", "msg", "-j", "focused-output"]
        running: false
        stdout: StdioCollector { id: focusStdout; waitForEnd: true }
        stderr: StdioCollector { id: focusStderr; waitForEnd: true }
        onExited: function(exitCode, exitStatus) { root.queryFinished(exitCode); }
    }

    PanelWindow {
        id: overlay
        screen: root.targetScreen
        visible: root.overlayMapped
        color: "transparent"

        WlrLayershell.namespace: "familiar:desktop-moments"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.exclusionMode: ExclusionMode.Ignore
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

        anchors {
            top: true
            left: true
            right: true
            bottom: true
        }

        mask: Region { item: null }

        Item {
            anchors.fill: parent
            clip: true

            Image {
                id: familiarImage
                source: root.activeCandidate === null ? "" : "file://" + root.activeCandidate.sprite
                asynchronous: true
                cache: false
                smooth: true
                // The error fall rotates the sprite, and error art runs to its
                // image bounds, so the quad's own edge shows.
                antialiasing: true
                fillMode: Image.PreserveAspectFit
                width: implicitHeight > 0 ? height * implicitWidth / implicitHeight : 0
                onStatusChanged: root.startWhenReady()
            }
        }

        onWidthChanged: Qt.callLater(root.startWhenReady)
        onHeightChanged: Qt.callLater(root.startWhenReady)
    }

    Connections {
        target: familiarImage.Window.window
        enabled: root.pendingLaunch !== null
        function onFrameSwapped() { root.frameSwapped(); }
    }

    Timer {
        id: watchdog
        // Total lifecycle budget; the longest v1 choreography is 2230 ms.
        interval: 6000
        repeat: false
        onTriggered: root.failMoment("moment timed out")
    }

    NumberAnimation {
        id: yAnimation
        target: familiarImage
        property: "y"
        onFinished: root.animationFinished()
    }

    NumberAnimation {
        id: opacityAnimation
        target: familiarImage
        property: "opacity"
        easing.type: Easing.InOutQuad
        onFinished: root.animationFinished()
    }

    Timer {
        id: hold
        repeat: false
        onTriggered: root.holdFinished()
    }
}
