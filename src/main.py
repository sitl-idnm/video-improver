from youtube_shorts_generator import YouTubeShortsGenerator
import os

def main():
    generator = YouTubeShortsGenerator()

    # URL видео для обработки
    video_url = input("Введите URL YouTube видео: ")

    # Скачиваем видео
    video_path = generator.download_video(video_url)
    if not video_path:
        print("Не удалось скачать видео")
        return

    # Генерируем шортсы
    shorts = generator.generate_shorts(video_path)

    # Анализируем потенциал каждого шортса
    for short_path in shorts:
        potential_views = generator.analyze_potential_views(short_path)
        print(f"Шортс {short_path}: Потенциальные просмотры - {potential_views}")

    # Удаляем временное видео
    os.remove(video_path)

if __name__ == "__main__":
    main()
