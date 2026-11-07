package com.fleetguard.console

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader

/**
 * FleetGuard Console for Android.
 *  - Demo/offline: the bundled console (assets/www) served from a secure https
 *    origin via WebViewAssetLoader; the reference backend runs on the phone.
 *  - Server: loads your FleetGuard server (same-origin cookies, real backend).
 * Navigation is locked to that one origin; everything else opens in the browser.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var origin: String = ASSET_ORIGIN

    companion object {
        const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
        const val DEMO_URL = "$ASSET_ORIGIN/assets/www/index.html"
        /** Built-in production server (set at build time), if any. */
        fun defaultServer(ctx: Context): String? = ctx.getString(R.string.default_server_url).trim().trimEnd('/').takeIf { it.startsWith("https://") }?.let { "$it/" }
        fun serverUrl(ctx: Context): String? = ctx.getSharedPreferences("console", MODE_PRIVATE).getString("serverUrl", null) ?: defaultServer(ctx)
        fun chosen(ctx: Context): Boolean = ctx.getSharedPreferences("console", MODE_PRIVATE).getBoolean("chosen", false) || defaultServer(ctx) != null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!chosen(this)) {
            startActivity(Intent(this, ConnectionActivity::class.java))
            finish()
            return
        }
        val server = serverUrl(this)
        val start = server ?: DEMO_URL
        origin = Uri.parse(start).let { "${it.scheme}://${it.authority}" }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()

        web = WebView(this)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
        }
        web.addJavascriptInterface(NativeBridge(this), "FleetGuardNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (server == null) assets.shouldInterceptRequest(request.url) else null

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if ("${u.scheme}://${u.authority}" == origin) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }
        setContentView(web)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(start)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    @Deprecated("Use OnBackPressedDispatcher in AndroidX apps")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }
}

/** Lets the console save exports (CSV inventory, audit JSON, DSAR) to Downloads. */
class NativeBridge(private val ctx: Context) {
    @JavascriptInterface
    fun saveFile(name: String, mime: String, base64: String): Boolean = try {
        val safe = name.replace(Regex("[^A-Za-z0-9._@-]"), "_").take(120)
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safe)
            put(MediaStore.Downloads.MIME_TYPE, mime.take(80))
        }
        val uri = if (Build.VERSION.SDK_INT >= 29) ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) else null
        if (uri != null) {
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            (ctx as Activity).runOnUiThread { Toast.makeText(ctx, "Saved to Downloads: $safe", Toast.LENGTH_LONG).show() }
            true
        } else false
    } catch (_: Exception) {
        false
    }
}
