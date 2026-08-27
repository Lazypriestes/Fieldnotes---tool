"""List audio devices, so you can find the name to pass to --device."""

import sounddevice as sd

for i, d in enumerate(sd.query_devices()):
    tag = []
    if d["max_input_channels"]:
        tag.append(f"in:{d['max_input_channels']}")
    if d["max_output_channels"]:
        tag.append(f"out:{d['max_output_channels']}")
    marker = "  <- capture from this" if d["max_input_channels"] else ""
    print(f"{i:>3}  {d['name']:<40} {','.join(tag):<12}{marker}")
