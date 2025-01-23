from moviepy.editor import VideoFileClip
from pytube import YouTube
import os
import tensorflow as tf
import numpy as np

class YouTubeShortsGenerator:
    def __init__(self, output_dir="output_shorts"):
        self.output_dir = output_dir
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)

    def download_video(self, url):
        try:
            yt = YouTube(url)
            stream = yt.streams.filter(progressive=True, file_extension='mp4').first()
            return stream.download(filename='temp_video.mp4')
        except Exception as e:
            print(f"Ошибка при скачивании: {str(e)}")
            return None

    def generate_shorts(self, video_path):
        video = VideoFileClip(video_path)
        duration = video.duration
        shorts = []

        # Нарезаем видео на сегменты по 60 секунд
        for start_time in range(0, int(duration), 60):
            end_time = min(start_time + 60, duration)
            segment = video.subclip(start_time, end_time)

            if segment.duration >= 15:  # Минимальная длина для Shorts
                output_path = os.path.join(self.output_dir, f"short_{start_time}.mp4")
                segment.write_videofile(output_path)
                shorts.append(output_path)

        video.close()
        return shorts

    def analyze_potential_views(self, video_path):
        # Здесь будет логика анализа потенциала видео
        # Пока возвращаем случайное число для демонстрации
        return np.random.randint(1000, 100000)
