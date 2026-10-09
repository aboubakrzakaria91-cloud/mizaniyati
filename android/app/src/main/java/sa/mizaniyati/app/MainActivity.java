package sa.mizaniyati.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Hosts the Mizaniyati web app (assets/index.html) and gives it what a browser can't:
 * reading bank SMS from the inbox, receiving shared text, and saving export files.
 */
public class MainActivity extends Activity {
    private static final int REQ_SMS = 1;
    private static final int REQ_FILE = 2;
    private static final int MAX_SMS = 3000;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingShare;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "MizaniyatiAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if ("file".equals(uri.getScheme())) return false;
                // Links to other sites open in the phone's browser.
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingShare != null) { deliverShare(pendingShare); pendingShare = null; }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        pendingShare = sharedText(getIntent());
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String text = sharedText(intent);
        if (text == null) return;
        if (pageReady) deliverShare(text); else pendingShare = text;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) js("window.mizaniyatiResume && window.mizaniyatiResume()");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_SMS) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        js("window.onSmsPermission && window.onSmsPermission(" + granted + ")");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    private static String sharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        CharSequence t = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        return t == null ? null : t.toString();
    }

    private void deliverShare(String text) {
        js("window.mizaniyatiShare && window.mizaniyatiShare(" + JSONObject.quote(text) + ")");
    }

    private void js(String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    private boolean hasSms() {
        return checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED;
    }

    /** Exposed to the page as window.MizaniyatiAndroid. */
    private class Bridge {
        @JavascriptInterface
        public boolean hasSmsPermission() { return hasSms(); }

        @JavascriptInterface
        public void requestSmsPermission() {
            runOnUiThread(() -> {
                if (hasSms()) js("window.onSmsPermission && window.onSmsPermission(true)");
                else requestPermissions(new String[]{Manifest.permission.READ_SMS}, REQ_SMS);
            });
        }

        /** Inbox messages newer than {@code sinceMillis}, oldest first, as JSON [{address, body, date}]. */
        @JavascriptInterface
        public String readSms(String sinceMillis) {
            JSONArray out = new JSONArray();
            if (!hasSms()) return out.toString();
            long since;
            try { since = Long.parseLong(sinceMillis); } catch (Exception e) { since = 0; }
            String[] cols = {"address", "body", "date"};
            try (Cursor c = getContentResolver().query(Uri.parse("content://sms/inbox"), cols,
                    "date >= ?", new String[]{String.valueOf(since)}, "date ASC")) {
                if (c == null) return out.toString();
                while (c.moveToNext() && out.length() < MAX_SMS) {
                    JSONObject m = new JSONObject();
                    m.put("address", c.getString(0) == null ? "" : c.getString(0));
                    m.put("body", c.getString(1) == null ? "" : c.getString(1));
                    m.put("date", c.getLong(2));
                    out.put(m);
                }
            } catch (Exception ignored) { }
            return out.toString();
        }

        /** Saves an export (CSV / backup) to Downloads/Mizaniyati and returns a message for the user. */
        @JavascriptInterface
        public String saveFile(String name, String text) {
            String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            String mime = safe.endsWith(".csv") ? "text/csv" : safe.endsWith(".json") ? "application/json" : "text/plain";
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Mizaniyati");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new IllegalStateException("insert failed");
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(bytes); }
                    return "تم الحفظ في: التنزيلات ← Mizaniyati ← " + safe;
                }
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Mizaniyati");
                if (!dir.exists() && !dir.mkdirs()) dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                File f = new File(dir, safe);
                try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                return "تم الحفظ في: " + f.getAbsolutePath();
            } catch (Exception e) {
                return "تعذّر حفظ الملف";
            }
        }
    }
}
