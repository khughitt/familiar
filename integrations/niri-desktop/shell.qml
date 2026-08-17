import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "logic.js" as Logic

ShellRoot {
    id: root

    readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/familiar"
    property var observedStates: ({})
    property bool initialized: false
    property string activeState: ""
    property var queryCandidate: null
    property var pendingCandidate: null
    property var activeCandidate: null
    property ShellScreen targetScreen: null
    property bool overlayMapped: false
    property bool playbackStarted: false
    property string phase: ""

    function applyIntent(text) {
        const parsed = Logic.parseIntent(text);
        if (parsed.error !== null) {
            console.warn("[familiar-desktop] " + parsed.error);
            return;
        }
        const observation = Logic.observe(parsed.intent, observedStates, initialized);
        observedStates = observation.states;
        initialized = true;
        retry.stop();
        handleCandidate(observation.candidate);
    }

    function handleCandidate(candidate) {
        const active = activeState === "" ? null : activeState;
        const decision = Logic.decidePlayback(active, candidate);
        if (decision.action === "none" || decision.action === "drop") return;

        if (decision.action === "preempt") unmapVisual();
        if (decision.mode === "off") {
            finishPlayback();
            return;
        }

        activeState = candidate.state;
        watchdog.restart();
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
                if (queryCandidate === candidate && activeState === candidate.state) {
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

    function finishPlayback() {
        watchdog.stop();
        queryCandidate = null;
        pendingCandidate = null;
        if (focusQuery.running) focusQuery.running = false;
        unmapVisual();
        activeState = "";
    }

    function failMoment(message) {
        console.warn("[familiar-desktop] " + message);
        finishPlayback();
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

    function startFull() {
        if (activeCandidate.state === "done") {
            configureSmall(1);
            animateY(peekY(), 250, Easing.OutCubic, "done-entered");
        } else {
            configureLarge(1);
            familiarImage.rotation = 8;
            animateY(overlay.height, 1100, Easing.InQuad, "error-fallen");
        }
    }

    function startReduced() {
        if (activeCandidate.state === "done") {
            configureSmall(0);
            familiarImage.y = peekY();
            animateOpacity(1, 200, "done-faded-in");
        } else {
            configureLarge(0);
            familiarImage.y = (overlay.height - familiarImage.height) / 2;
            animateOpacity(1, 200, "error-faded-in");
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
        id: intentView
        path: root.stateDir + "/intent.json"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.applyIntent(text())
        onLoadFailed: retry.start()
    }

    Timer {
        id: retry
        interval: 3000
        repeat: true
        onTriggered: intentView.reload()
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
                fillMode: Image.PreserveAspectFit
                width: implicitHeight > 0 ? height * implicitWidth / implicitHeight : 0
                onStatusChanged: root.startWhenReady()
            }
        }

        onWidthChanged: Qt.callLater(root.startWhenReady)
        onHeightChanged: Qt.callLater(root.startWhenReady)
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
