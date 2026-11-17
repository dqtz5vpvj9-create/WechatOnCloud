"""Stream XFixes clipboard ownership changes without reading clipboard data."""
import ctypes
import ctypes.util
import os
import select
import sys

os.environ.setdefault('DISPLAY', ':1')
x = ctypes.CDLL(ctypes.util.find_library('X11'))
fixes = ctypes.CDLL(ctypes.util.find_library('Xfixes'))
ptr = ctypes.c_void_p
ulong = ctypes.c_ulong
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ptr
x.XDefaultRootWindow.argtypes = [ptr]
x.XDefaultRootWindow.restype = ulong
x.XInternAtom.argtypes = [ptr, ctypes.c_char_p, ctypes.c_int]
x.XInternAtom.restype = ulong
x.XConnectionNumber.argtypes = [ptr]
x.XConnectionNumber.restype = ctypes.c_int
x.XPending.argtypes = [ptr]
x.XNextEvent.argtypes = [ptr, ptr]
x.XFlush.argtypes = [ptr]
fixes.XFixesQueryExtension.argtypes = [ptr, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
fixes.XFixesSelectSelectionInput.argtypes = [ptr, ulong, ulong, ulong]

class SelectionEvent(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ulong), ('send_event', ctypes.c_int),
                ('display', ptr), ('window', ulong), ('subtype', ctypes.c_int),
                ('owner', ulong), ('selection', ulong), ('timestamp', ulong),
                ('selection_timestamp', ulong)]

class Event(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('selection', SelectionEvent), ('pad', ctypes.c_long * 24)]

display = x.XOpenDisplay(None)
if not display:
    raise SystemExit('Cannot open X display')
base, error = ctypes.c_int(), ctypes.c_int()
if not fixes.XFixesQueryExtension(display, ctypes.byref(base), ctypes.byref(error)):
    raise SystemExit('XFixes is unavailable')
clipboard = x.XInternAtom(display, b'CLIPBOARD', 0)
fixes.XFixesSelectSelectionInput(display, x.XDefaultRootWindow(display), clipboard, 1 | 2 | 4)
x.XFlush(display)
print('ready', flush=True)
fd = x.XConnectionNumber(display)
while True:
    if not x.XPending(display):
        readable = select.select([fd, sys.stdin], [], [], 5)[0]
        if sys.stdin in readable and not os.read(sys.stdin.fileno(), 1):
            break
        if not readable:
            print('keepalive', flush=True)
            continue
    while x.XPending(display):
        event = Event()
        x.XNextEvent(display, ctypes.byref(event))
        if event.type == base.value and event.selection.subtype == 0 and event.selection.owner:
            print('changed', flush=True)
