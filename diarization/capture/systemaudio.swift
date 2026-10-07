// systemaudio — capture macOS system (or one app's) audio via a Core Audio PROCESS TAP,
// the driver-free API Apple shipped in macOS 14.4. No virtual device, no output rerouting:
// your default output and volume keys are untouched. (This replaced a ScreenCaptureKit
// version whose audio tap returned no buffers on macOS 26.)
//
// Emits the fixed Fieldnotes capture CONTRACT on stdout:
//     raw PCM, 16 kHz, mono, float32, little-endian
// so it pipes straight into `pipeline.py --source stdin`. Swap this program for any other
// that honours the same contract and nothing else changes.
//
// Logs go to STDERR; stdout is data only.
//
//   ./systemaudio                           # all system audio
//   ./systemaudio --app "Microsoft Teams"   # only that app's audio
//   ./systemaudio --with-mic                # 2 channels: ch0 = your microphone, ch1 = system audio
//                                           #   (a call: you on ch0, the other side on ch1)
//
// First run asks for the system-audio-recording permission for 'Fieldnotes System Audio'.

import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

let TARGET_SR = 16000.0
func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

// ---- args ----
var appMatch: String? = nil
var withMic = false          // --with-mic: 2-channel output, ch0 = microphone (you), ch1 = system (them)
do {
    var i = 1
    let a = CommandLine.arguments
    while i < a.count {
        if a[i] == "--app", i + 1 < a.count { appMatch = a[i + 1]; i += 2 }
        else { if a[i] == "--with-mic" { withMic = true }; i += 1 }
    }
}

// ---- 2-channel mixer (--with-mic): pairs mic + system samples into interleaved frames ----
final class Mixer {
    private var mic = [Float](), sys = [Float]()
    private let lock = NSLock()
    func push(mic s: [Float]) { lock.lock(); mic.append(contentsOf: s); lock.unlock() }
    func push(sys s: [Float]) { lock.lock(); sys.append(contentsOf: s); lock.unlock() }
    /// Interleaved [mic, sys] frames ready to write. If one side runs more than 0.5 s ahead
    /// (the other device stalled or went idle), the lagging side is padded with silence so
    /// the two channels stay time-aligned.
    func drain() -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        let maxLag = Int(TARGET_SR * 0.5)
        if mic.count > sys.count + maxLag { sys.append(contentsOf: [Float](repeating: 0, count: mic.count - sys.count)) }
        if sys.count > mic.count + maxLag { mic.append(contentsOf: [Float](repeating: 0, count: sys.count - mic.count)) }
        let n = min(mic.count, sys.count)
        if n == 0 { return nil }
        var out = [Float](repeating: 0, count: n * 2)
        for i in 0..<n { out[2 * i] = mic[i]; out[2 * i + 1] = sys[i] }
        mic.removeFirst(n); sys.removeFirst(n)
        return out
    }
}
let mixer = Mixer()
let engine = AVAudioEngine()      // kept alive for the process lifetime (mic capture)
var emitTimer: DispatchSourceTimer?

/// Convert one buffer to 16 kHz mono float32 samples.
func toTarget(_ conv: AVAudioConverter, _ inBuf: AVAudioPCMBuffer, _ target: AVAudioFormat) -> [Float]? {
    let cap = AVAudioFrameCount(Double(inBuf.frameLength) * TARGET_SR / inBuf.format.sampleRate) + 64
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return nil }
    var err: NSError?
    var fed = false
    conv.convert(to: outBuf, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true; status.pointee = .haveData; return inBuf
    }
    if err != nil { return nil }
    let n = Int(outBuf.frameLength)
    guard n > 0, let ch = outBuf.floatChannelData else { return nil }
    return Array(UnsafeBufferPointer(start: ch[0], count: n))
}

func startMic(_ target: AVAudioFormat) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .denied, .restricted:
        log("microphone access denied — allow it under System Settings › Privacy & Security › Microphone"); exit(1)
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        AVCaptureDevice.requestAccess(for: .audio) { g in ok = g; sem.signal() }
        sem.wait()
        if !ok { log("microphone access was not granted"); exit(1) }
    default: break
    }
    let input = engine.inputNode
    let fmt = input.outputFormat(forBus: 0)
    guard fmt.sampleRate > 0, fmt.channelCount > 0, let conv = AVAudioConverter(from: fmt, to: target) else {
        log("no usable microphone input"); exit(1)
    }
    conv.downmix = true
    input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in
        if let s = toTarget(conv, buf, target) { mixer.push(mic: s) }
    }
    do { try engine.start() } catch { log("cannot start microphone: \(error.localizedDescription)"); exit(1) }
    let name = AVCaptureDevice.default(for: .audio)?.localizedName ?? "default input"
    log("microphone: \(name) (\(Int(fmt.sampleRate)) Hz, \(fmt.channelCount) ch)")

    let out = FileHandle.standardOutput
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "fn.emit"))
    t.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
    t.setEventHandler {
        if let frames = mixer.drain() {
            frames.withUnsafeBufferPointer { out.write(Data(buffer: $0)) }
        }
    }
    t.resume()
    emitTimer = t
}

// ---- Core Audio helpers ----
let SYS = AudioObjectID(kAudioObjectSystemObject)

func cfStringProp(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: sel,
                                          mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return nil }
    var cf: Unmanaged<CFString>?
    let st = AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &cf)
    guard st == noErr, let v = cf?.takeRetainedValue() else { return nil }
    return v as String
}

func processObjects() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                          mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(SYS, &addr, 0, nil, &size) == noErr else { return [] }
    let n = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: n)
    guard AudioObjectGetPropertyData(SYS, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

// Match running audio processes to a name (bundle id substring, case-insensitive).
func matchingProcesses(_ name: String) -> [AudioObjectID] {
    return processObjects().filter { pid in
        if let bid = cfStringProp(pid, kAudioProcessPropertyBundleID),
           bid.localizedCaseInsensitiveContains(name) { return true }
        return false
    }
}

// ---- state kept for teardown ----
var tapID = AudioObjectID(0)
var aggID = AudioObjectID(0)
var ioProcID: AudioDeviceIOProcID?

func teardown() {
    emitTimer?.cancel()
    if withMic { engine.stop() }
    if aggID != 0, let p = ioProcID {
        AudioDeviceStop(aggID, p)
        AudioDeviceDestroyIOProcID(aggID, p)
    }
    if aggID != 0 { AudioHardwareDestroyAggregateDevice(aggID) }
    if tapID != 0 { AudioHardwareDestroyProcessTap(tapID) }
}

@available(macOS 14.4, *)
func run() {
    // 1. describe the tap: whole-system, or specific processes for --app.
    let desc: CATapDescription
    if let name = appMatch {
        let procs = matchingProcesses(name)
        if procs.isEmpty { log("no running audio process matching '\(name)'"); exit(1) }
        log("tapping audio from \(procs.count) process(es) matching '\(name)'")
        desc = CATapDescription(stereoMixdownOfProcesses: procs)
    } else {
        log("tapping all system audio")
        desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    }
    desc.name = "Fieldnotes System Audio"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted   // never silence the real output while we listen

    // 2. create the tap.
    var st = AudioHardwareCreateProcessTap(desc, &tapID)
    guard st == noErr, tapID != 0 else {
        log("cannot create audio tap (status \(st)). If this is a permission error, grant")
        log("'Fieldnotes System Audio' under System Settings › Privacy & Security › Audio / Screen & System Audio Recording.")
        exit(1)
    }

    // 3. wrap the tap in a private aggregate device so we can run an IOProc on it.
    let aggUID = "com.fieldnotes.systemaudio.agg.\(UUID().uuidString)"
    let aggDesc: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: "Fieldnotes Tap",
        kAudioAggregateDeviceUIDKey as String: aggUID,
        kAudioAggregateDeviceIsPrivateKey as String: true,
        kAudioAggregateDeviceIsStackedKey as String: false,
        kAudioAggregateDeviceTapAutoStartKey as String: true,
        kAudioAggregateDeviceTapListKey as String: [
            [ kAudioSubTapUIDKey as String: desc.uuid.uuidString,
              kAudioSubTapDriftCompensationKey as String: true ]
        ]
    ]
    st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
    guard st == noErr, aggID != 0 else { log("cannot create aggregate device (status \(st))"); teardown(); exit(1) }

    // 4. source format = the tap's stream format (float32, device SR, N ch).
    var fmtAddr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var asbd = AudioStreamBasicDescription()
    var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    st = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &asbdSize, &asbd)
    guard st == noErr, asbd.mSampleRate > 0, let srcFormat = AVAudioFormat(streamDescription: &asbd) else {
        log("cannot read tap format (status \(st))"); teardown(); exit(1)
    }
    log("tap format: \(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch")

    // 5. converter -> 16 kHz mono f32, and the stdout sink.
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                               sampleRate: TARGET_SR, channels: 1, interleaved: true)!
    guard let converter = AVAudioConverter(from: srcFormat, to: target) else {
        log("cannot build audio converter"); teardown(); exit(1)
    }
    converter.downmix = true
    let out = FileHandle.standardOutput
    var firstBuf = true

    let block: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: srcFormat,
                                           bufferListNoCopy: inInputData,
                                           deallocator: nil),
              inBuf.frameLength > 0 else { return }
        if firstBuf { firstBuf = false; log("first audio buffer flowing — capture is live") }
        guard let samples = toTarget(converter, inBuf, target) else { return }
        if withMic { mixer.push(sys: samples) }
        else { samples.withUnsafeBufferPointer { out.write(Data(buffer: $0)) } }
    }

    // 6. install + start.
    st = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggID, nil, block)
    guard st == noErr, ioProcID != nil else { log("cannot create IOProc (status \(st))"); teardown(); exit(1) }
    st = AudioDeviceStart(aggID, ioProcID)
    guard st == noErr else { log("cannot start device (status \(st))"); teardown(); exit(1) }

    if withMic {
        startMic(target)
        log("started (16 kHz, 2 ch f32 -> stdout: ch0 = microphone/you, ch1 = system/them). ctrl-c to stop.")
    } else {
        log("started (16 kHz mono f32 -> stdout). ctrl-c to stop.")
    }
}

// clean stop; private tap + aggregate are also auto-removed by the OS on exit.
signal(SIGINT)  { _ in teardown(); exit(0) }
signal(SIGTERM) { _ in teardown(); exit(0) }

if #available(macOS 14.4, *) {
    run()
    RunLoop.main.run()
} else {
    log("needs macOS 14.4+ for Core Audio process taps.")
    exit(1)
}
