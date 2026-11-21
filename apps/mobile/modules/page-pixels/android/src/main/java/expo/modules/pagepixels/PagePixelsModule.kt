package expo.modules.pagepixels

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.InputStream
import kotlin.math.roundToInt

private class PageDecodeException(message: String) :
  CodedException("ERR_PAGE_PIXELS", message, null)

/**
 * Decodes a page image straight to grayscale pixels at a target size, off the
 * JS thread. Replaces the JS path (save JPEG, base64, jpeg-js decode), which
 * blocked the JS thread for ~1 s per page.
 *
 * Steps (mirrored by `native_gray` in the check_app_pipeline.py scripts
 * under tools/orientation and tools/page-number):
 * power-of-two sampled JPEG decode, EXIF rotation, bilinear scale to the exact
 * size, ITU-R 601 luma as PIL computes it.
 */
class PagePixelsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PagePixels")

    // AsyncFunction bodies run on the modules' background queue.
    AsyncFunction("grayscale") { uri: String, width: Int?, height: Int? ->
      if ((width == null) == (height == null)) {
        throw PageDecodeException("Pass exactly one of width or height")
      }
      grayscale(uri = uri, width = width, height = height)
    }
  }

  private fun open(uri: String): InputStream {
    val context = appContext.reactContext
      ?: throw PageDecodeException("No React context")
    return context.contentResolver.openInputStream(Uri.parse(uri))
      ?: throw PageDecodeException("Cannot open $uri")
  }

  private fun rotationDegrees(uri: String): Int =
    open(uri).use {
      when (ExifInterface(it).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL,
      )) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
      }
    }

  private fun grayscale(uri: String, width: Int?, height: Int?): Map<String, Any> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw PageDecodeException("Not an image: $uri")
    }

    val degrees = rotationDegrees(uri)
    val swap = degrees == 90 || degrees == 270
    val uprightW = if (swap) bounds.outHeight else bounds.outWidth
    val uprightH = if (swap) bounds.outWidth else bounds.outHeight
    val targetW = width ?: (uprightW * height!!.toDouble() / uprightH).roundToInt()
    val targetH = height ?: (uprightH * width!!.toDouble() / uprightW).roundToInt()

    // Largest power of two that keeps the decode at least the target size;
    // the decoder averages while sampling, so this acts as the antialiasing.
    var sample = 1
    while (uprightW / (sample * 2) >= targetW && uprightH / (sample * 2) >= targetH) {
      sample *= 2
    }

    val decoded = open(uri).use {
      BitmapFactory.decodeStream(
        it,
        null,
        BitmapFactory.Options().apply {
          inSampleSize = sample
          inPreferredConfig = Bitmap.Config.ARGB_8888
        },
      )
    } ?: throw PageDecodeException("Could not decode $uri")

    val upright = if (degrees == 0) {
      decoded
    } else {
      val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
      Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
        .also { if (it !== decoded) decoded.recycle() }
    }
    val scaled = Bitmap.createScaledBitmap(upright, targetW, targetH, true)
    if (scaled !== upright) upright.recycle()

    val argb = IntArray(targetW * targetH)
    scaled.getPixels(argb, 0, targetW, 0, 0, targetW, targetH)
    scaled.recycle()

    val gray = ByteArray(argb.size)
    for (i in argb.indices) {
      val p = argb[i]
      val r = (p shr 16) and 0xff
      val g = (p shr 8) and 0xff
      val b = p and 0xff
      gray[i] = ((r * 19595 + g * 38470 + b * 7471 + 0x8000) shr 16).toByte()
    }
    return mapOf("gray" to gray, "width" to targetW, "height" to targetH)
  }
}
