import os
from PIL import Image

def main():
    print("Generating dummy test images in raw_photos/...")
    
    os.makedirs("raw_photos/01_Ceremony", exist_ok=True)
    os.makedirs("raw_photos/02_Party", exist_ok=True)
    
    # 1. Ceremony Landscape (Gold theme color)
    img_c1 = Image.new("RGB", (1200, 800), color=(214, 175, 55))
    img_c1.save("raw_photos/01_Ceremony/ceremony_kiss.jpg")
    
    # 2. Ceremony Portrait (Warm white)
    img_c2 = Image.new("RGB", (800, 1200), color=(245, 244, 240))
    img_c2.save("raw_photos/01_Ceremony/bride_groom.jpg")
    
    # 3. Party Square (Dark charcoal)
    img_p1 = Image.new("RGB", (1000, 1000), color=(22, 22, 20))
    img_p1.save("raw_photos/02_Party/first_dance.jpg")
    
    print("Successfully created test structure:")
    print("  - raw_photos/01_Ceremony/ceremony_kiss.jpg (Landscape)")
    print("  - raw_photos/01_Ceremony/bride_groom.jpg (Portrait)")
    print("  - raw_photos/02_Party/first_dance.jpg (Square)")
    print("\nNext, run:")
    print("  python3 process_photos.py")

if __name__ == "__main__":
    main()
