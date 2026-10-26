# Third-party notices

The ISPSoft file-transform modules under `ispsoft_mcp/` include code from the
MIT-licensed [Delta PLC Agent](https://github.com/ufukefekaya-tr/delta-plc-agent)
(pinned source commit `f4f041a`; source manifest identifies the vendored codec
revisions). Its project `LICENSE` is included at the repository root.

The following components retain their separate MIT notices in
`ispsoft_mcp/_vendor/`:

| Component | Source | Notice |
|---|---|---|
| ISPSoft container codec | [delta-ispsoft-codec](https://github.com/ahmetdumlupinarr/delta-ispsoft-codec) | `ispsoft_mcp/_vendor/LICENSE-ispsoft-codec.txt` |
| DVP IL/MPU serializers | [delta-plc-agent](https://github.com/ufukefekaya-tr/delta-plc-agent) | `ispsoft_mcp/_vendor/LICENSE-dvp-ispsoft.txt` |

The codec is used only for formats its implementation recognizes. Protected or
unknown project variants are rejected, and source transformation is reported
as uncompiled until the native ISPSoft build/check step has been run separately.
