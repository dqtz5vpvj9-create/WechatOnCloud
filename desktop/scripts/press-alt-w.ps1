# Fixed OS-level shortcut input for the isolated desktop regression test.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YunweiShortcutInput {
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union data; }
    [StructLayout(LayoutKind.Explicit)] public struct Union {
        [FieldOffset(0)] public Keyboard keyboard;
        [FieldOffset(0)] public Mouse mouse;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Keyboard {
        public ushort key, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Mouse {
        public int x, y; public uint data, flags, time; public UIntPtr extra;
    }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
    public static void Press() {
        var inputs = new Input[4];
        ushort[] keys = { 0x12, 0x57, 0x57, 0x12 };
        for (int i=0; i<4; i++) {
            inputs[i].type=1; inputs[i].data.keyboard.key=keys[i];
            inputs[i].data.keyboard.flags = i>=2 ? 2u : 0u;
        }
        if (SendInput(4, inputs, Marshal.SizeOf<Input>()) != 4)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
[YunweiShortcutInput]::Press()
