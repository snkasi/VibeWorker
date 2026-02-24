import os
import sys
from PIL import Image, ImageOps

def invert_logo():
    logo_path = os.path.join(os.path.dirname(__file__), 'logo.png')
    out_path = os.path.join(os.path.dirname(__file__), 'logo-white.png')
    
    if not os.path.exists(logo_path):
        print("logo.png not found")
        sys.exit(1)
        
    img = Image.open(logo_path).convert("RGBA")
    r, g, b, a = img.split()
    rgb_image = Image.merge('RGB', (r,g,b))
    inverted_image = ImageOps.invert(rgb_image)
    r2, g2, b2 = inverted_image.split()
    final_transparent_image = Image.merge('RGBA', (r2, g2, b2, a))
    final_transparent_image.save(out_path, "PNG")
    print("Successfully created True Inverted logo-white.png")

if __name__ == '__main__':
    invert_logo()
