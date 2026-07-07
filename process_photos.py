import os
import sys
import json
import time
import hashlib
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PIL import Image, ImageOps
import dotenv

# Load environment variables from .env if present
dotenv.load_dotenv()

# Configuration Defaults
RAW_DIR = Path("raw_photos")
MANIFEST_FILE = Path(".gallery_manifest.json")

# Allowed media formats
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.heic'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.m4v', '.webm'}

def get_env_or_prompt(key, prompt_msg, secure=False):
    """Retrieve an environment variable or prompt the user if not set."""
    val = os.getenv(key)
    if not val:
        val = input(prompt_msg).strip()
        if secure and not val:
            print(f"Error: {key} is required.")
            sys.exit(1)
    return val

def check_ffmpeg():
    """Verify if ffmpeg is installed on the system."""
    try:
        subprocess.run(['ffmpeg', '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except Exception:
        return False

def calculate_md5(file_path):
    """Calculate the MD5 hash of a file to check for changes."""
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

def extract_video_thumbnail(video_path, thumbnail_path, has_ffmpeg):
    """Extract a thumbnail from a video file. Falls back if ffmpeg is missing."""
    if not has_ffmpeg:
        return False
    try:
        # Seek to 1 second and grab 1 frame
        cmd = [
            'ffmpeg', '-ss', '00:00:01', 
            '-i', str(video_path), 
            '-vframes', '1', 
            '-q:v', '4',  # high quality scale
            str(thumbnail_path), '-y'
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except Exception:
        return False

def convert_heic_to_jpg(heic_path, temp_jpg_path):
    """Convert HEIC to JPEG using macOS native sips tool."""
    try:
        cmd = ['sips', '-s', 'format', 'jpeg', str(heic_path), '--out', str(temp_jpg_path)]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return True
    except Exception as e:
        print(f"  [HEIC Warning] Failed to convert {heic_path.name} via sips: {e}")
        return False

def process_single_media(file_path, has_ffmpeg, manifest):
    """Process a single image or video file. Returns dictionary of metadata."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()
    
    # Calculate file signature (path + modification time)
    mtime = file_path.stat().st_mtime
    file_signature = f"{file_path}_{mtime}"
    
    # Check manifest for cached processing
    if file_signature in manifest:
        meta = manifest[file_signature]
        meta["signature"] = file_signature
        meta["source_path"] = str(file_path)
        return meta, False  # (metadata, was_processed=False)

    # Determine collection and category based on subfolder structure
    # raw_photos/[collection]/[category]/[file]
    collection = "General"
    category = "General"
    relative_parts = file_path.relative_to(RAW_DIR).parts
    
    if len(relative_parts) > 1:
        collection = relative_parts[0]
        if len(relative_parts) > 2:
            raw_category = relative_parts[1]
        else:
            raw_category = "General"
            
        # Strip ordering prefixes like "01_", "02 - " from category name
        category = raw_category
        for prefix in ["_", "-", " "]:
            parts = category.split(prefix, 1)
            if len(parts) > 1 and parts[0].isdigit():
                category = parts[1].strip()
                break

    print(f"Processing: {file_path.relative_to(RAW_DIR)}")

    # Initialize metadata
    meta = {
        "signature": file_signature,
        "source_path": str(file_path),
        "name": file_path.name,
        "collection": collection,
        "category": category,
        "type": "image" if ext in IMAGE_EXTENSIONS else "video",
        "original_filename": file_path.name,
        "aspect_ratio": 1.0,
        "width": 0,
        "height": 0
    }

    # Setup local destination directory structure in the root
    thumbnails_dir = Path("thumbnails")
    optimized_dir = Path("optimized")

    for d in [thumbnails_dir, optimized_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # Create safe output filenames using path-based hash to avoid naming collisions & timeouts
    file_hash = hashlib.md5(file_signature.encode('utf-8')).hexdigest()[:12]
    safe_name = f"{file_hash}_{file_path.stem.lower()}"
    safe_name = "".join(c if c.isalnum() or c in ('-', '_') else '_' for c in safe_name)

    if ext in IMAGE_EXTENSIONS:
        # Target output paths
        thumb_name = f"{safe_name}_thumb.webp"
        opt_name = f"{safe_name}_opt.webp"
        orig_name = f"{safe_name}{ext}"

        thumb_path = thumbnails_dir / thumb_name
        opt_path = optimized_dir / opt_name

        # We do NOT copy the original file locally to save disk space.
        # It will be uploaded directly from the source directory.

        # Handle HEIC files by converting them to temporary JPEG using macOS sips
        temp_img_path = None
        current_img_path = file_path
        if ext == '.heic':
            temp_img_path = Path(f"temp_{safe_name}.jpg")
            if convert_heic_to_jpg(file_path, temp_img_path):
                current_img_path = temp_img_path
            else:
                return None, False

        # Open image and auto-orient based on EXIF
        try:
            with Image.open(current_img_path) as img:
                img = ImageOps.exif_transpose(img)
                width, height = img.size
                meta["width"] = width
                meta["height"] = height
                meta["aspect_ratio"] = round(width / height, 3)

                # 1. Save Thumbnail (max width 400px)
                thumb_img = img.copy()
                thumb_img.thumbnail((400, 400), Image.Resampling.LANCZOS)
                thumb_img.save(thumb_path, format="WEBP", quality=75)

                # 2. Save Optimized Fullscreen (max width 1920px)
                opt_img = img.copy()
                opt_img.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
                opt_img.save(opt_path, format="WEBP", quality=82)
        except Exception as e:
            print(f"  [Error] Failed processing image {file_path.name}: {e}")
            if temp_img_path and temp_img_path.exists():
                temp_img_path.unlink()
            return None, False

        # Clean up temp file
        if temp_img_path and temp_img_path.exists():
            temp_img_path.unlink()

        # Update metadata URLs (will be served relative to R2 bucket root)
        meta["thumbnail"] = f"thumbnails/{thumb_name}"
        meta["optimized"] = f"optimized/{opt_name}"
        meta["original"] = f"originals/{orig_name}"

    elif ext in VIDEO_EXTENSIONS:
        video_name = f"{safe_name}{ext}"
        thumb_name = f"{safe_name}_vthumb.jpg"
        
        thumb_path = thumbnails_dir / thumb_name

        # We do NOT copy the video locally to save disk space.

        # Generate thumbnail frame
        success = extract_video_thumbnail(file_path, thumb_path, has_ffmpeg)
        if success:
            try:
                with Image.open(thumb_path) as img:
                    width, height = img.size
                    meta["width"] = width
                    meta["height"] = height
                    meta["aspect_ratio"] = round(width / height, 3)
            except Exception:
                meta["aspect_ratio"] = 1.778  # default 16:9
        else:
            meta["aspect_ratio"] = 1.778  # default 16:9

        meta["thumbnail"] = f"thumbnails/{thumb_name}" if success else None
        meta["original"] = f"videos/{video_name}"
        meta["optimized"] = f"videos/{video_name}"  # standard video streaming

    # Save to cache
    manifest[file_signature] = meta
    return meta, True

def upload_file_to_r2(s3_client, bucket_name, local_path, r2_key):
    """Upload a single file to Cloudflare R2 using boto3."""
    local_path = Path(local_path)
    if not local_path.exists():
        return False
    
    # Determine Content-Type
    ext = local_path.suffix.lower()
    content_type = "application/octet-stream"
    if ext == ".html":
        content_type = "text/html"
    elif ext == ".css":
        content_type = "text/css"
    elif ext == ".js":
        content_type = "application/javascript"
    elif ext == ".json":
        content_type = "application/json"
    elif ext in (".jpg", ".jpeg"):
        content_type = "image/jpeg"
    elif ext == ".png":
        content_type = "image/png"
    elif ext == ".webp":
        content_type = "image/webp"
    elif ext == ".heic":
        content_type = "image/heic"
    elif ext == ".mp4":
        content_type = "video/mp4"
    elif ext == ".mov":
        content_type = "video/quicktime"
    elif ext == ".webm":
        content_type = "video/webm"

    try:
        s3_client.upload_file(
            Filename=str(local_path),
            Bucket=bucket_name,
            Key=r2_key,
            ExtraArgs={"ContentType": content_type}
        )
        return True
    except Exception as e:
        print(f"Error uploading {local_path.name} to R2: {e}")
        return False

def upload_single_media_item(s3_client, bucket_name, files):
    """Uploads all files associated with a single media item. Returns True if all uploads succeeded."""
    success = True
    for local_path, r2_key in files:
        ok = upload_file_to_r2(s3_client, bucket_name, local_path, r2_key)
        if not ok:
            success = False
    return success

def save_env_file(account_id, access_key, secret_key, gallery_pass, family_pass, bucket_urls):
    """Write environment configurations to .env file."""
    with open(".env", "w", encoding="utf-8") as f:
        f.write(f"CLOUDFLARE_ACCOUNT_ID={account_id or ''}\n")
        f.write(f"R2_ACCESS_KEY_ID={access_key or ''}\n")
        f.write(f"R2_SECRET_ACCESS_KEY={secret_key or ''}\n")
        f.write(f"GALLERY_PASSWORD={gallery_pass or ''}\n")
        f.write(f"FAMILY_PASSWORD={family_pass or ''}\n")
        for col, url in bucket_urls.items():
            env_key = f"R2_BUCKET_URL_{col.upper().replace('-', '_').replace(' ', '_')}"
            f.write(f"{env_key}={url or ''}\n")

def main():
    print("==============================================")
    print(" Wedding Photo & Video Processor / R2 Uploader")
    print("==============================================")

    # 1. Check requirements
    has_ffmpeg = check_ffmpeg()
    if not has_ffmpeg:
        print("[Notice] FFmpeg is not installed. Video thumbnail extraction will be skipped.")
        print("         Install FFmpeg (`brew install ffmpeg`) to enable video cover images.")
    else:
        print("[Ok] FFmpeg found. Video frame extraction enabled.")

    # Check for raw photos folder
    if not RAW_DIR.exists():
        RAW_DIR.mkdir()
        print(f"\n[Info] Created '{RAW_DIR}' folder.")
        print(f"Please put your raw photos and videos inside '{RAW_DIR}/' and re-run this script.")
        print("You can group them into subfolders (e.g. '01_Ceremony', '02_Party') to create tabs.")
        sys.exit(0)

    # Load local manifest (cache) to skip already processed files
    manifest = {}
    if MANIFEST_FILE.exists():
        try:
            with open(MANIFEST_FILE, "r") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    # Scan raw files
    raw_files = []
    for ext in IMAGE_EXTENSIONS.union(VIDEO_EXTENSIONS):
        raw_files.extend(list(RAW_DIR.glob(f"**/*{ext}")))
        raw_files.extend(list(RAW_DIR.glob(f"**/*{ext.upper()}")))

    if not raw_files:
        print(f"\nNo files found in '{RAW_DIR}/'. Please add photos/videos and run again.")
        sys.exit(0)

    print(f"Found {len(raw_files)} photos/videos to process.")

    # 2. Process Files
    gallery_data = []
    processed_count = 0
    skipped_count = 0

    # Process in parallel using a ThreadPool
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(process_single_media, f, has_ffmpeg, manifest): f for f in raw_files}
        for future in as_completed(futures):
            meta, was_processed = future.result()
            if meta:
                gallery_data.append(meta)
                if was_processed:
                    processed_count += 1
                else:
                    skipped_count += 1

    # Save manifest cache
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nProcessing Complete: {processed_count} processed, {skipped_count} skipped/cached.")

    # Sort gallery items: by collection, then category, then filename
    gallery_data.sort(key=lambda x: (x.get("collection", ""), x.get("category", ""), x.get("name", "")))
    
    # Remove helper keys before writing catalog for client browser use
    clean_gallery_data = []
    for item in gallery_data:
        clean_item = item.copy()
        clean_item.pop("signature", None)
        clean_item.pop("source_path", None)
        clean_gallery_data.append(clean_item)
        
    with open("gallery-data.json", "w") as f:
        json.dump(clean_gallery_data, f, indent=2)
        
    print(f"Saved metadata catalog to gallery-data.json")

    # Load config file or create with defaults
    config_file = Path("gallery-config.json")
    DEFAULT_CONFIG = {
        "title": "Our Memories",
        "subtitle": "M a y  1 2 ,  2 0 2 6",
        "collectionNames": {
            "damcuoisaigon": "Đám Cưới Sài Gòn",
            "damcuoisoctrang": "Đám Cưới Sóc Trăng"
        },
        "accessRules": {},
        "r2BucketUrls": {
            "damcuoisaigon": "your-damcuoisaigon-public-r2-url",
            "damcuoisoctrang": "https://pub-86972fb9a9c542b7bc60b4213b784a8f.r2.dev/"
        }
    }
    config_data = DEFAULT_CONFIG.copy()
    if config_file.exists():
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                config_data.update(loaded)
        except Exception as e:
            print(f"[Warning] Failed to load {config_file}: {e}")

    # Build r2BucketUrls dynamically from env or prompts
    env_urls_json = os.getenv("R2_BUCKET_URLS")
    if env_urls_json:
        try:
            config_data.setdefault("r2BucketUrls", {}).update(json.loads(env_urls_json))
        except Exception:
            pass

    # Find all collections in the processed media
    collections = sorted(list(set(item.get("collection") for item in gallery_data if item.get("collection"))))

    r2_bucket_urls = config_data.setdefault("r2BucketUrls", {})
    for col in collections:
        if col not in r2_bucket_urls or r2_bucket_urls[col] in ("your-damcuoisaigon-public-r2-url", ""):
            # Try to get individual env variable R2_BUCKET_URL_[COLLECTION]
            env_key = f"R2_BUCKET_URL_{col.upper().replace('-', '_').replace(' ', '_')}"
            val = os.getenv(env_key)
            if val:
                r2_bucket_urls[col] = val
            else:
                # Prompt user for input
                val = input(f"Enter R2 Public URL for collection '{col}': ").strip()
                if val:
                    r2_bucket_urls[col] = val

    config_data["r2BucketUrls"] = r2_bucket_urls

    # Load/prompt passwords
    GALLERY_PASSWORD = get_env_or_prompt("GALLERY_PASSWORD", "Default Gallery Password (full access): ", secure=True)
    FAMILY_PASSWORD = get_env_or_prompt("FAMILY_PASSWORD", "Family Gallery Password (limited access): ", secure=True)

    # Compute hashes
    gallery_hash = hashlib.sha256(GALLERY_PASSWORD.encode('utf-8')).hexdigest()
    family_hash = hashlib.sha256(FAMILY_PASSWORD.encode('utf-8')).hexdigest()

    # Update accessRules (mapping hashes to collections)
    config_data["accessRules"] = {
        gallery_hash: "*",
        family_hash: [col for col in collections if col != "General"]
    }

    # Save gallery-config.json
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(config_data, f, indent=2)
    print(f"Saved configuration catalog to {config_file}")

    # Save credentials and passwords to .env
    save_env_file(
        os.getenv("CLOUDFLARE_ACCOUNT_ID"),
        os.getenv("R2_ACCESS_KEY_ID"),
        os.getenv("R2_SECRET_ACCESS_KEY"),
        GALLERY_PASSWORD,
        FAMILY_PASSWORD,
        r2_bucket_urls
    )

    # 3. Cloudflare R2 Upload Choice
    upload_choice = input("\nDo you want to upload the files to Cloudflare R2 now? (y/n): ").strip().lower()
    if upload_choice != 'y':
        print("\nSkipping R2 upload. You can run the script again later to upload.")
        print("To preview the website locally, run a server inside the project root folder:")
        print("  python3 -m http.server 8000")
        sys.exit(0)

    # Fetch R2 credentials
    CLOUDFLARE_ACCOUNT_ID = get_env_or_prompt("CLOUDFLARE_ACCOUNT_ID", "Cloudflare Account ID: ", secure=True)
    R2_ACCESS_KEY_ID = get_env_or_prompt("R2_ACCESS_KEY_ID", "R2 Access Key ID: ", secure=True)
    R2_SECRET_ACCESS_KEY = get_env_or_prompt("R2_SECRET_ACCESS_KEY", "R2 Secret Access Key: ", secure=True)
    
    # Save .env file again for convenience next time
    save_env_file(
        CLOUDFLARE_ACCOUNT_ID,
        R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY,
        GALLERY_PASSWORD,
        FAMILY_PASSWORD,
        r2_bucket_urls
    )
    print("\nSaved R2 credentials to .env file for future runs.")

    # Connect to S3-compatible R2 Client
    import boto3
    from botocore.config import Config
    try:
        s3_client = boto3.client(
            service_name='s3',
            endpoint_url=f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
            config=Config(signature_version="s3v4")
        )
    except Exception as e:
        print(f"Failed to create boto3 client: {e}")
        sys.exit(1)

    # Optional: fetch existing bucket list to warn if local folder name doesn't match any R2 bucket
    existing_buckets = set()
    try:
        response = s3_client.list_buckets()
        existing_buckets = {b['Name'] for b in response.get('Buckets', [])}
        print(f"\nSuccessfully verified R2 connection. Available buckets on account: {', '.join(existing_buckets)}")
    except Exception as e:
        print(f"\n[Warning] Could not fetch bucket list from R2 (could be TLS provisioning delay): {e}")
        print("Continuing with upload attempt...")

    print("\nBuilding dynamic R2 upload queue from gallery metadata...")
    media_items_to_upload = []
    
    for item in gallery_data:
        sig = item.get("signature")
        if sig and manifest.get(sig, {}).get("uploaded_to_r2"):
            # Already successfully uploaded in a previous run
            continue
            
        bucket_name = item.get("collection")
        if not bucket_name:
            continue
        
        # Verify if bucket name is valid / exists in R2 if we could retrieve the list
        if existing_buckets and bucket_name not in existing_buckets:
            print(f"[Warning] Local collection folder '{bucket_name}' does not match any existing R2 bucket.")
            print(f"          Please make sure a bucket named '{bucket_name}' exists in your R2 account.")

        files_to_upload = []
        source_path = item.get("source_path")
        
        # 1. Thumbnail (local path is under thumbnails/)
        if item.get("thumbnail"):
            local_path = Path(item["thumbnail"])
            if local_path.exists():
                files_to_upload.append((local_path, item["thumbnail"]))
                
        # 2. Optimized (local path is under optimized/)
        if item.get("optimized"):
            if item.get("type") == "image":
                local_path = Path(item["optimized"])
                if local_path.exists():
                    files_to_upload.append((local_path, item["optimized"]))
                    
        # 3. Original / Video (local path is the raw source_path)
        if source_path:
            local_source = Path(source_path)
            if local_source.exists():
                files_to_upload.append((local_source, item["original"]))

        if files_to_upload:
            media_items_to_upload.append({
                "signature": sig,
                "bucket": bucket_name,
                "files": files_to_upload
            })

    if not media_items_to_upload:
        print("All processed media files are already uploaded and synced to R2!")
        sys.exit(0)

    print(f"Found {len(media_items_to_upload)} new or modified media items to upload.")

    # Upload media items in parallel
    uploaded_items_count = 0
    newly_uploaded_signatures = []
    
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(upload_single_media_item, s3_client, item["bucket"], item["files"]): item
            for item in media_items_to_upload
        }
        for future in as_completed(futures):
            item = futures[future]
            sig = item["signature"]
            if future.result():
                uploaded_items_count += 1
                if sig:
                    newly_uploaded_signatures.append(sig)
                if uploaded_items_count % 5 == 0 or uploaded_items_count == len(media_items_to_upload):
                    print(f"Uploaded {uploaded_items_count}/{len(media_items_to_upload)} items...")

    # If any new items were uploaded, update manifest cache
    if newly_uploaded_signatures:
        for sig in newly_uploaded_signatures:
            if sig in manifest:
                manifest[sig]["uploaded_to_r2"] = True
        with open(MANIFEST_FILE, "w") as f:
            json.dump(manifest, f, indent=2)
        print("Updated manifest cache with successful upload status.")

    print(f"\nR2 Bucket Synchronization finished. Uploaded {uploaded_items_count} media items successfully.")
    print("Your gallery is ready! Double check your CORS policy in Cloudflare R2 settings for all buckets.")

if __name__ == "__main__":
    main()
