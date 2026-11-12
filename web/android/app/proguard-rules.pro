# Rules for the release build (R8). The app's own code is one empty Activity; what must survive shrinking
# is Capacitor's bridge and its plugins, which the web page calls by name through reflection.

# Capacitor's core
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }

# Every plugin: the class, and the methods the web side calls
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
}
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes *Annotation*, JavascriptInterface, Signature, InnerClasses, EnclosingMethod

# The background location plugin's service and receivers (named in the manifest)
-keep class com.equimaps.capacitor_background_geolocation.** { *; }

# Cordova's compatibility layer, which Capacitor loads by name
-keep class org.apache.cordova.** { *; }
-dontwarn org.apache.cordova.**

# Stack traces that can be read
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile
