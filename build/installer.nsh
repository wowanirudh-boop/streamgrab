; Extra NSIS steps for the StreamGrab installer (electron-builder "include").
; The app registers its native-messaging host on every start; the uninstaller
; removes that registration so Chrome does not keep pointing at a deleted exe.

!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.streamgrab.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.streamgrab.host"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.streamgrab.host"
  DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\com.streamgrab.host"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.streamgrab.host"
  Delete "$APPDATA\StreamGrab\com.streamgrab.host.json"
  Delete "$APPDATA\StreamGrab\bridge.json"
!macroend
