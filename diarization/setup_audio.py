"""Create and activate the Multi-Output Device from the command line.

Normally this is a click-path in Audio MIDI Setup. This drives the same CoreAudio
calls directly, so setup is one command and is reproducible.

    python setup_audio.py status     # what exists, what is routed where
    python setup_audio.py create     # build "Interview Capture" (BlackHole + speakers)
    python setup_audio.py activate   # route system sound through it
    python setup_audio.py revert     # back to the built-in speakers
    python setup_audio.py destroy    # remove the device again

Needs no password: an aggregate device is per-user audio config, not a system setting.
"""

import argparse
import ctypes
import ctypes.util
import sys

ca = ctypes.CDLL(ctypes.util.find_library("CoreAudio"))
cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))

c_void_p, c_uint32, c_int32 = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32
UTF8 = 0x08000100
SYSTEM_OBJECT = 1
MULTI_OUTPUT_NAME = "Interview Capture"
MULTI_OUTPUT_UID = "com.interview-assistant.multiout"


def fourcc(s):
    return int.from_bytes(s.encode(), "big")


SEL_DEVICES = fourcc("dev#")
SEL_UID = fourcc("uid ")
SEL_NAME = fourcc("lnam")
SEL_DEFAULT_OUT = fourcc("dOut")
SEL_STREAM_CONFIG = fourcc("slay")
SEL_VOLUME = fourcc("volm")     # kAudioDevicePropertyVolumeScalar, Float32 0..1
SEL_MUTE = fourcc("mute")       # kAudioDevicePropertyMute, UInt32 0/1
SCOPE_GLOBAL = fourcc("glob")
SCOPE_INPUT = fourcc("inpt")
SCOPE_OUTPUT = fourcc("outp")


class AOPA(ctypes.Structure):
    _fields_ = [("mSelector", c_uint32), ("mScope", c_uint32), ("mElement", c_uint32)]


class AudioBuffer(ctypes.Structure):
    _fields_ = [("mNumberChannels", c_uint32), ("mDataByteSize", c_uint32),
                ("mData", c_void_p)]


class AudioBufferList(ctypes.Structure):
    _fields_ = [("mNumberBuffers", c_uint32), ("mBuffers", AudioBuffer * 1)]


def addr(selector):
    return AOPA(selector, SCOPE_GLOBAL, 0)


# ---- CoreFoundation helpers ----------------------------------------------
cf.CFStringCreateWithCString.restype = c_void_p
cf.CFStringCreateWithCString.argtypes = [c_void_p, ctypes.c_char_p, c_uint32]
cf.CFStringGetCString.argtypes = [c_void_p, ctypes.c_char_p, ctypes.c_long, c_uint32]
cf.CFNumberCreate.restype = c_void_p
cf.CFNumberCreate.argtypes = [c_void_p, ctypes.c_long, c_void_p]
cf.CFDictionaryCreate.restype = c_void_p
cf.CFDictionaryCreate.argtypes = [c_void_p, c_void_p, c_void_p, ctypes.c_long,
                                  c_void_p, c_void_p]
cf.CFArrayCreate.restype = c_void_p
cf.CFArrayCreate.argtypes = [c_void_p, c_void_p, ctypes.c_long, c_void_p]
cf.CFRelease.argtypes = [c_void_p]

DICT_KEY_CB = ctypes.byref(c_void_p.in_dll(cf, "kCFTypeDictionaryKeyCallBacks"))
DICT_VAL_CB = ctypes.byref(c_void_p.in_dll(cf, "kCFTypeDictionaryValueCallBacks"))
ARRAY_CB = ctypes.byref(c_void_p.in_dll(cf, "kCFTypeArrayCallBacks"))


def cfstr(s):
    return cf.CFStringCreateWithCString(None, s.encode(), UTF8)


def from_cfstr(ref):
    buf = ctypes.create_string_buffer(1024)
    if not ref or not cf.CFStringGetCString(ref, buf, 1024, UTF8):
        return ""
    return buf.value.decode()


def cfnum(value):
    v = ctypes.c_int(value)
    return cf.CFNumberCreate(None, 9, ctypes.byref(v))  # 9 = kCFNumberIntType


def cfdict(pairs):
    n = len(pairs)
    keys = (c_void_p * n)(*[p[0] for p in pairs])
    vals = (c_void_p * n)(*[p[1] for p in pairs])
    return cf.CFDictionaryCreate(None, keys, vals, n, DICT_KEY_CB, DICT_VAL_CB)


def cfarray(items):
    n = len(items)
    arr = (c_void_p * n)(*items)
    return cf.CFArrayCreate(None, arr, n, ARRAY_CB)


# ---- CoreAudio -----------------------------------------------------------
ca.AudioObjectGetPropertyDataSize.argtypes = [c_uint32, ctypes.POINTER(AOPA),
                                              c_uint32, c_void_p,
                                              ctypes.POINTER(c_uint32)]
ca.AudioObjectGetPropertyData.argtypes = [c_uint32, ctypes.POINTER(AOPA), c_uint32,
                                          c_void_p, ctypes.POINTER(c_uint32), c_void_p]
ca.AudioObjectSetPropertyData.argtypes = [c_uint32, ctypes.POINTER(AOPA), c_uint32,
                                          c_void_p, c_uint32, c_void_p]
ca.AudioHardwareCreateAggregateDevice.argtypes = [c_void_p, ctypes.POINTER(c_uint32)]
ca.AudioHardwareCreateAggregateDevice.restype = c_int32
ca.AudioHardwareDestroyAggregateDevice.argtypes = [c_uint32]
ca.AudioHardwareDestroyAggregateDevice.restype = c_int32
ca.AudioObjectHasProperty.argtypes = [c_uint32, ctypes.POINTER(AOPA)]
ca.AudioObjectHasProperty.restype = ctypes.c_ubyte
ca.AudioObjectIsPropertySettable.argtypes = [c_uint32, ctypes.POINTER(AOPA),
                                             ctypes.POINTER(ctypes.c_ubyte)]
ca.AudioObjectIsPropertySettable.restype = c_int32


def device_ids():
    a = addr(SEL_DEVICES)
    size = c_uint32()
    ca.AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, ctypes.byref(a), 0, None,
                                      ctypes.byref(size))
    count = size.value // ctypes.sizeof(c_uint32)
    ids = (c_uint32 * count)()
    ca.AudioObjectGetPropertyData(SYSTEM_OBJECT, ctypes.byref(a), 0, None,
                                  ctypes.byref(size), ids)
    return list(ids)


def _cfstring_prop(dev_id, selector):
    a = addr(selector)
    ref = c_void_p()
    size = c_uint32(ctypes.sizeof(c_void_p))
    if ca.AudioObjectGetPropertyData(dev_id, ctypes.byref(a), 0, None,
                                     ctypes.byref(size), ctypes.byref(ref)) != 0:
        return ""
    return from_cfstr(ref)


def channels(dev_id, scope):
    """Channel count in one direction. Needed because names alone are ambiguous --
    'MacBook Pro' matches both the microphone and the speakers, and building a
    Multi-Output Device on the microphone produces a device that emits nothing."""
    a = AOPA(SEL_STREAM_CONFIG, scope, 0)
    size = c_uint32()
    if ca.AudioObjectGetPropertyDataSize(dev_id, ctypes.byref(a), 0, None,
                                         ctypes.byref(size)) != 0:
        return 0
    buf = ctypes.create_string_buffer(size.value)
    if ca.AudioObjectGetPropertyData(dev_id, ctypes.byref(a), 0, None,
                                     ctypes.byref(size), buf) != 0:
        return 0
    abl = ctypes.cast(buf, ctypes.POINTER(AudioBufferList)).contents
    if not abl.mNumberBuffers:
        return 0
    arr = ctypes.cast(ctypes.byref(abl.mBuffers),
                      ctypes.POINTER(AudioBuffer * abl.mNumberBuffers)).contents
    return sum(b.mNumberChannels for b in arr)


def devices():
    out = []
    for d in device_ids():
        out.append((d, _cfstring_prop(d, SEL_NAME), _cfstring_prop(d, SEL_UID),
                    channels(d, SCOPE_INPUT), channels(d, SCOPE_OUTPUT)))
    return out


def find(fragment, need_output=False, need_input=False):
    for dev_id, name, uid, ins, outs in devices():
        if fragment.lower() not in name.lower():
            continue
        if need_output and outs == 0:
            continue
        if need_input and ins == 0:
            continue
        return dev_id, name, uid
    return None


def default_output():
    a = addr(SEL_DEFAULT_OUT)
    dev = c_uint32()
    size = c_uint32(ctypes.sizeof(c_uint32))
    ca.AudioObjectGetPropertyData(SYSTEM_OBJECT, ctypes.byref(a), 0, None,
                                  ctypes.byref(size), ctypes.byref(dev))
    return dev.value


def set_default_output(dev_id):
    a = addr(SEL_DEFAULT_OUT)
    dev = c_uint32(dev_id)
    return ca.AudioObjectSetPropertyData(SYSTEM_OBJECT, ctypes.byref(a), 0, None,
                                         ctypes.sizeof(c_uint32), ctypes.byref(dev))


def _has(dev_id, selector, element):
    a = AOPA(selector, SCOPE_OUTPUT, element)
    return bool(ca.AudioObjectHasProperty(dev_id, ctypes.byref(a)))


def _settable(dev_id, selector, element):
    a = AOPA(selector, SCOPE_OUTPUT, element)
    yn = ctypes.c_ubyte()
    if ca.AudioObjectIsPropertySettable(dev_id, ctypes.byref(a), ctypes.byref(yn)) != 0:
        return False
    return bool(yn.value)


def get_volume(dev_id):
    """Loudest of the volume-carrying elements, 0..1, or None if the device has no
    volume control at all (an Aggregate/Multi-Output Device is one such case)."""
    best = None
    for element in (0, 1, 2):                       # 0 = master, 1/2 = L/R channels
        if not _has(dev_id, SEL_VOLUME, element):
            continue
        val = ctypes.c_float()
        size = c_uint32(ctypes.sizeof(ctypes.c_float))
        a = AOPA(SEL_VOLUME, SCOPE_OUTPUT, element)
        if ca.AudioObjectGetPropertyData(dev_id, ctypes.byref(a), 0, None,
                                         ctypes.byref(size), ctypes.byref(val)) == 0:
            best = val.value if best is None else max(best, val.value)
    return best


def set_volume(dev_id, fraction):
    """Set every settable volume element and clear mute. Returns True if anything took.
    Works on the real speaker device even while it is buried inside the aggregate,
    which is the whole point -- the Multi-Output Device itself has no volume knob."""
    fraction = max(0.0, min(1.0, fraction))
    touched = False
    for element in (0, 1, 2):
        if not (_has(dev_id, SEL_VOLUME, element)
                and _settable(dev_id, SEL_VOLUME, element)):
            continue
        val = ctypes.c_float(fraction)
        a = AOPA(SEL_VOLUME, SCOPE_OUTPUT, element)
        if ca.AudioObjectSetPropertyData(dev_id, ctypes.byref(a), 0, None,
                                         ctypes.sizeof(ctypes.c_float),
                                         ctypes.byref(val)) == 0:
            touched = True
    for element in (0, 1, 2):                       # also lift any mute flag
        if not (_has(dev_id, SEL_MUTE, element)
                and _settable(dev_id, SEL_MUTE, element)):
            continue
        off = c_uint32(0)
        a = AOPA(SEL_MUTE, SCOPE_OUTPUT, element)
        ca.AudioObjectSetPropertyData(dev_id, ctypes.byref(a), 0, None,
                                      ctypes.sizeof(c_uint32), ctypes.byref(off))
    return touched


# ---- commands ------------------------------------------------------------

def cmd_status():
    cur = default_output()
    print("audio devices:")
    for dev_id, name, uid, ins, outs in devices():
        mark = "  <- system output" if dev_id == cur else ""
        io = ",".join(([f"in:{ins}"] if ins else []) + ([f"out:{outs}"] if outs else []))
        print(f"  {name:<28} {io:<12}{mark}")

    print()
    bh = find("BlackHole")
    multi = find(MULTI_OUTPUT_NAME)
    spk = find("MacBook Pro", need_output=True)
    print(f"  BlackHole present      : {'yes' if bh else 'NO  -> brew install blackhole-2ch'}")
    print(f"  Multi-Output present   : {'yes' if multi else 'NO  -> setup_audio.py create'}")
    routed = bool(multi) and cur == multi[0]
    capture_only = bool(bh) and cur == bh[0]
    print(f"  sound routed through it: {'yes' if routed else 'NO  -> setup_audio.py activate'}")
    if spk:
        vol = get_volume(spk[0])
        print(f"  speaker volume         : "
              f"{'%.0f%%' % (vol * 100) if vol is not None else 'n/a'}")
    print()
    if bh and multi and routed:
        print("  ready (monitor). audio reaches BlackHole AND your speakers.")
    elif capture_only:
        print("  ready (silent). audio reaches BlackHole only -- you hear nothing.")
    else:
        print("  not ready yet - fix the NO lines above, in order.")


def cmd_create(speaker_fragment):
    if find(MULTI_OUTPUT_NAME):
        print(f'"{MULTI_OUTPUT_NAME}" already exists. Nothing to do.')
        return 0

    bh = find("BlackHole", need_output=True)
    spk = find(speaker_fragment, need_output=True)
    if not bh:
        print("BlackHole not found. Install it, then restart CoreAudio:")
        print("  brew install blackhole-2ch && sudo killall coreaudiod")
        return 1
    if not spk:
        print(f'No OUTPUT device matching "{speaker_fragment}". Outputs available:')
        for _, name, _, _, outs in devices():
            if outs:
                print("  ", name)
        return 1

    # Speakers first: the first sub-device is the master clock. Drift correction
    # goes on BlackHole so the two clocks cannot slowly separate over a long call.
    subs = cfarray([
        cfdict([(cfstr("uid"), cfstr(spk[2]))]),
        cfdict([(cfstr("uid"), cfstr(bh[2])), (cfstr("drift"), cfnum(1))]),
    ])
    desc = cfdict([
        (cfstr("name"), cfstr(MULTI_OUTPUT_NAME)),
        (cfstr("uid"), cfstr(MULTI_OUTPUT_UID)),
        (cfstr("subdevices"), subs),
        (cfstr("master"), cfstr(spk[2])),
        (cfstr("stacked"), cfnum(1)),   # stacked aggregate == Multi-Output Device
        (cfstr("private"), cfnum(0)),   # visible and persistent
    ])

    new_id = c_uint32()
    status = ca.AudioHardwareCreateAggregateDevice(desc, ctypes.byref(new_id))
    if status != 0:
        print(f"CoreAudio refused to create the device (OSStatus {status})")
        return 1
    print(f'created "{MULTI_OUTPUT_NAME}"  =  {spk[1]} (master) + {bh[1]} (drift corrected)')
    return 0


def cmd_activate():
    multi = find(MULTI_OUTPUT_NAME)
    if not multi:
        print("Nothing to activate - run: setup_audio.py create")
        return 1
    if set_default_output(multi[0]) != 0:
        print("could not switch the system output")
        return 1
    print(f'system output -> "{multi[1]}"')
    print("you still hear everything; a copy now reaches BlackHole")
    return 0


def cmd_volume(speaker_fragment, level):
    spk = find(speaker_fragment, need_output=True)
    if not spk:
        print(f'no output device matching "{speaker_fragment}"')
        return 1
    if set_volume(spk[0], level / 100.0):
        print(f'{spk[1]} volume -> {level}% (and unmuted)')
        return 0
    print(f'{spk[1]} has no settable volume')
    return 1


def cmd_capture_only(device_fragment):
    """Route system sound to BlackHole alone: captured, but you hear nothing."""
    bh = find(device_fragment, need_output=True)
    if not bh:
        print(f'no output device matching "{device_fragment}"')
        return 1
    if set_default_output(bh[0]) != 0:
        print("could not switch the system output")
        return 1
    print(f'system output -> "{bh[1]}" (silent: capture only, nothing to speakers)')
    return 0


def cmd_revert(speaker_fragment):
    spk = find(speaker_fragment, need_output=True)
    if not spk:
        print(f'no output device matching "{speaker_fragment}"')
        return 1
    set_default_output(spk[0])
    print(f'system output -> "{spk[1]}"')
    return 0


def cmd_destroy():
    multi = find(MULTI_OUTPUT_NAME)
    if not multi:
        print("nothing to remove")
        return 0
    if default_output() == multi[0]:
        print("it is the current output - run 'revert' first")
        return 1
    if ca.AudioHardwareDestroyAggregateDevice(multi[0]) != 0:
        print("could not remove it")
        return 1
    print(f'removed "{MULTI_OUTPUT_NAME}"')
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command",
                   choices=["status", "create", "activate", "capture-only",
                            "volume", "revert", "destroy"])
    p.add_argument("--speakers", default="MacBook Pro",
                   help="name fragment of the device you actually listen through")
    p.add_argument("--device", default="BlackHole",
                   help="capture device for 'capture-only'")
    p.add_argument("--level", type=int, default=45,
                   help="volume percent for the 'volume' command")
    args = p.parse_args()

    if args.command == "status":
        return cmd_status()
    if args.command == "create":
        return cmd_create(args.speakers)
    if args.command == "activate":
        return cmd_activate()
    if args.command == "capture-only":
        return cmd_capture_only(args.device)
    if args.command == "volume":
        return cmd_volume(args.speakers, args.level)
    if args.command == "revert":
        return cmd_revert(args.speakers)
    if args.command == "destroy":
        return cmd_destroy()


if __name__ == "__main__":
    sys.exit(main() or 0)
