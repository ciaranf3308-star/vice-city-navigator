# WayStation car shell — no obfuscation rules needed (minifyEnabled false),
# but keep the CarAppService entry point if minification is ever enabled.
-keep public class com.waystation.auto.WayStationCarAppService
-keep public class * extends androidx.car.app.CarAppService
