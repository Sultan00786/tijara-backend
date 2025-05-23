import sharp from "sharp";
import { FastifyRequest, FastifyReply } from "fastify";
import { MultipartFile } from "@fastify/multipart";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { uploadToR2 as uploadToCloudflare } from "../config/cloudflareR2.js";

// Define Express.Multer.File interface for compatibility
interface ExpressMulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size?: number;
  stream?: NodeJS.ReadableStream;
  destination?: string;
  filename?: string;
  path?: string;
}

// Extend FastifyRequest for TypeScript support
declare module "fastify" {
  interface FastifyRequest {
    processedImages?: Array<{
      url: string;
      order: number;
    }>;
    uploadedFiles?: string[];
  }
}

// Image type check
function isImage(mimetype: string) {
  return mimetype.startsWith("image/");
}

// Process image with sharp
export const processImage = async (
  buffer: Buffer,
  originalMimetype: string,
): Promise<{ buffer: Buffer; format: string }> => {
  // Extract metadata to preserve orientation and other important data
  const metadata = await sharp(buffer).metadata();

  // Create a base sharp instance with proper orientation handling
  let processor = sharp(buffer)
    .rotate() // Auto-rotate based on EXIF orientation
    .resize(1920, 1920, {
      // Support higher resolution images
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    });

  // Determine best output format
  // WebP for best compression, but keep original format for transparency (PNG) if needed
  if (metadata.hasAlpha && originalMimetype === "image/png") {
    // For PNGs with transparency, keep as PNG with good compression
    return {
      buffer: await processor
        .png({ quality: 90, compressionLevel: 9, palette: true })
        .toBuffer(),
      format: "png",
    };
  } else {
    // For all other images, convert to WebP for best quality/size ratio
    return {
      buffer: await processor
        .webp({
          quality: 92, // Higher quality for better images
          alphaQuality: 100, // Preserve alpha channel quality
          lossless: false, // Use lossy compression for smaller files
          nearLossless: false, // Better compression
          smartSubsample: true, // Improve color detail
          effort: 6, // Higher effort for better compression (0-6)
        })
        .toBuffer(),
      format: "webp",
    };
  }
};

// Middleware: Process & upload all images
export const processImagesMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const MIN_FILE_SIZE = 5 * 1024; // 5KB
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
  try {
    if (!request.isMultipart()) {
      console.log("Request is not multipart");
      return;
    }

    const processedImages: Array<{ url: string; order: number }> = [];
    const uploadedFiles: string[] = [];
    const formData: Record<string, any> = {};
    let index = 0;

    // Process all parts (files and fields)
    const parts = await request.parts();

    for await (const part of parts) {
      if (part.type === "file" && isImage(part.mimetype)) {
        // Process image file
        console.log(
          `Processing image file: ${part.filename}, field: ${part.fieldname}, size: ${(part.file.bytesRead / 1024).toFixed(1)}KB`,
        );
        const buffer = await part.toBuffer();
        const { buffer: processedBuffer, format } = await processImage(
          buffer,
          part.mimetype,
        );

        // Create a temporary file for the processed image
        const tempFilename = `processed-${crypto.randomUUID()}.${format}`;
        const tempFilePath = path.join(process.cwd(), "temp", tempFilename);

        // Ensure temp directory exists
        const tempDir = path.dirname(tempFilePath);
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write processed buffer to temp file
        fs.writeFileSync(tempFilePath, processedBuffer);

        // Log compression results
        console.log(
          `Image processed: Original: ${(buffer.length / 1024).toFixed(1)}KB, Compressed: ${(processedBuffer.length / 1024).toFixed(1)}KB, Savings: ${((1 - processedBuffer.length / buffer.length) * 100).toFixed(1)}%`,
        );

        const fileForUpload: ExpressMulterFile = {
          fieldname: part.fieldname,
          originalname: part.filename || tempFilename,
          encoding: part.encoding,
          mimetype: format === "webp" ? "image/webp" : `image/${format}`,
          buffer: processedBuffer,
          size: processedBuffer.length,
          destination: tempDir,
          filename: tempFilename,
          path: tempFilePath,
        };

        const { url } = await uploadToCloudflare(
          fileForUpload as any,
          "listings",
        );

        // Clean up temp file
        fs.unlinkSync(tempFilePath);

        processedImages.push({ url, order: index++ });
        uploadedFiles.push(url);
      } else if (part.type === "field") {
        // Process form field
        const value = await part.value;
        if (typeof value === "string") {
          try {
            // Try to parse as JSON if it looks like a JSON string
            formData[part.fieldname] =
              value.startsWith("{") || value.startsWith("[")
                ? JSON.parse(value)
                : value;
          } catch {
            // If parsing fails, use the raw value
            formData[part.fieldname] = value;
          }
        }
      }
    }

    // Attach processed data to request
    request.processedImages = processedImages;
    request.uploadedFiles = uploadedFiles;
    request.body = formData; // Replace the entire body to avoid circular references

    console.log("Processed request body:", JSON.stringify(formData, null, 2));
    console.log("Processed images:", processedImages);
  } catch (error) {
    console.error("❌ Error in processImagesMiddleware:", error);
    reply.status(500).send({ error: "Image processing failed" });
  }
};

// Middleware: Upload raw files without processing
export const uploadMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    if (!request.isMultipart()) {
      return;
    }

    const parts = request.parts();
    const uploadedFiles: string[] = [];

    for await (const part of parts) {
      if (part.type !== "file") continue;
      if (!isImage(part.mimetype)) continue;

      const chunks: Uint8Array[] = [];
      for await (const chunk of part.file) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      // Create a temporary file for the image
      const tempFilename = `upload-${crypto.randomUUID()}${path.extname(part.filename || "")}`;
      const tempFilePath = path.join(process.cwd(), "temp", tempFilename);

      // Ensure temp directory exists
      const tempDir = path.dirname(tempFilePath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Write buffer to temp file
      fs.writeFileSync(tempFilePath, buffer);

      const fileForUpload: ExpressMulterFile = {
        fieldname: part.fieldname,
        originalname: part.filename || tempFilename,
        encoding: part.encoding,
        mimetype: part.mimetype,
        buffer,
        size: buffer.length,
        destination: tempDir,
        filename: tempFilename,
        path: tempFilePath,
      };

      const { url } = await uploadToCloudflare(fileForUpload as any, "listing");

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      uploadedFiles.push(url);
    }

    request.uploadedFiles = uploadedFiles;
  } catch (error) {
    console.error("❌ Error in uploadMiddleware:", error);
    reply.status(500).send({ error: "Upload failed" });
  }
};

// Re-export for convenience
export { uploadToR2 } from "../config/cloudflareR2.js";
export { default as s3 } from "../config/cloudflareR2.js";

// Placeholder for upload object to maintain compatibility
export const upload = {
  single:
    (fieldname: string) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Implement single file upload logic if needed
    },
  array:
    (fieldname: string, maxCount: number) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Implement array upload logic if needed
    },
};
